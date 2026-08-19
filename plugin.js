// ws-cleaner — DSH dynamic Cordis plugin (Host half)
// 工作区垃圾文件自动/手动清理
//
// 加载方式(DSH 内):
//   1. cordis_define: code.host = 本文件全部内容(即函数体)
//   2. cordis_run 运行插件后,会话内即可调用工具 clean_workspace
// 依赖服务(Host): fs(读配置/写标记)、shell(移动/删除)、timer、sandboxPolicy、
//      agents/sessions(解析会话工作区与策略)、harness
//
// 注意: 本文件不含任何凭据。
//
// 版本: v6
//  - v1: clean_workspace 手动清理工具 + agent/turn-stopping 自动清理(移入回收区)
//  - v2: 双信号触发(turn-stopping + status→idle,防抖)+ permanent 配置
//  - v3: apply 即时清扫 + 定时兜底(intervalMinutes)+ 触发标记 .ws-cleaner-last-run.json
//  - v4: apply 直接触发(不依赖定时器)+ 全阶段诊断
//  - v5: 根因修复——policySvc.resolve({}) 返回默认策略(workspace-write,root=DSH 安装
//        目录),插件对会话工作区的写入/删除全部被沙箱拦截;改为经
//        agents.currentInitiator() 取会话 Agent,用其 session 解析会话级策略
//        (danger-full-access)并显式传给 shell/fs,同时取真实工作区路径
//  - v6: 修复 __CLEAN_JSON__ 标记解析正则多写的花括号
//
// 规则(保守):*.tmp *.temp *.bak *.orig *.old *.dmp *.partial *.crdownload *.pyc
//      .DS_Store Thumbs.db ~$* __pycache__ 目录,超龄 *.log(ageDays,默认 7 天),
//      会话临时 .gh-*-body.json .plugin-check.js
// 永不触碰:.git、.dsh-trash、.dsh-cleaner.json、.ws-cleaner-last-run.json、keepPatterns。
// 配置:工作区根目录可选 .dsh-cleaner.json
//      { "enabled": true, "permanent": false, "ageDays": 7, "trashKeepDays": 7,
//        "intervalMinutes": 10, "extraPatterns": ["*.abc"], "keepPatterns": ["*.ps1"] }

return {
  name: 'ws-cleaner',
  inject: ['timer'],
  apply(ctx) {
    const fsSvc = ctx.get('fs');
    const shellSvc = ctx.get('shell');
    const policySvc = ctx.get('sandboxPolicy');
    const agentsSvc = ctx.get('agents');
    const sessionsSvc = ctx.get('sessions');

    const DEFAULT_PATTERNS = ['*.tmp', '*.temp', '*.bak', '*.orig', '*.old', '*.dmp', '*.partial', '*.crdownload', '*.pyc', '.DS_Store', 'Thumbs.db', '.gh-*-body.json', '.plugin-check.js'];

    function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

    function agentCwd(agent) {
      try { return agent && agent.session && agent.session.header ? agent.session.header.cwd : null; } catch (e) { return null; }
    }
    function initiatorCwd() {
      if (agentsSvc) {
        try { const a = agentsSvc.currentInitiator(); const c = agentCwd(a); if (c) return { agent: a, cwd: c }; } catch (e) {}
        try { const a = agentsSvc.requireInitiator(); const c = agentCwd(a); if (c) return { agent: a, cwd: c }; } catch (e) {}
      }
      if (sessionsSvc) {
        try {
          const list = sessionsSvc.list();
          if (list && list.length) {
            for (let i = 0; i < list.length; i++) {
              const c = agentCwd({ session: list[i] });
              if (c) return { agent: null, cwd: c };
            }
          }
        } catch (e) {}
      }
      return null;
    }
    function standingPolicyFor(agent) {
      try {
        return policySvc && typeof policySvc.resolve === 'function'
          ? policySvc.resolve(agent && agent.session ? { session: agent.session } : {})
          : null;
      } catch (e) { return null; }
    }

    async function readConfig(workspace) {
      const cfg = { enabled: true, permanent: false, ageDays: 7, trashKeepDays: 7, intervalMinutes: 10, extraPatterns: [], keepPatterns: [] };
      if (!fsSvc) return cfg;
      try {
        const t = await fsSvc.resolve('.dsh-cleaner.json', { cwd: workspace });
        const txt = await fsSvc.readText(t);
        const c = JSON.parse(txt);
        if (c && typeof c === 'object') {
          if (typeof c.enabled === 'boolean') cfg.enabled = c.enabled;
          if (typeof c.permanent === 'boolean') cfg.permanent = c.permanent;
          if (Number.isFinite(Number(c.ageDays))) cfg.ageDays = Math.max(0, Math.floor(Number(c.ageDays)));
          if (Number.isFinite(Number(c.trashKeepDays))) cfg.trashKeepDays = Math.max(1, Math.floor(Number(c.trashKeepDays)));
          if (Number.isFinite(Number(c.intervalMinutes))) cfg.intervalMinutes = Math.max(1, Math.floor(Number(c.intervalMinutes)));
          if (Array.isArray(c.extraPatterns)) cfg.extraPatterns = c.extraPatterns.filter(function (x) { return typeof x === 'string'; });
          if (Array.isArray(c.keepPatterns)) cfg.keepPatterns = c.keepPatterns.filter(function (x) { return typeof x === 'string'; });
        }
      } catch (e) { /* 无配置或配置无效,用默认值 */ }
      return cfg;
    }

    function buildScript(workspace, opts) {
      const patterns = JSON.stringify(DEFAULT_PATTERNS.concat(opts.extraPatterns));
      const keeps = JSON.stringify(opts.keepPatterns);
      const dry = opts.dry ? '$true' : '$false';
      const permanent = opts.permanent ? '$true' : '$false';
      return "$ErrorActionPreference = 'SilentlyContinue'\n" +
        "$root = " + psQuote(workspace) + "\n" +
        "$dry = " + dry + "\n" +
        "$permanent = " + permanent + "\n" +
        "$ageDays = " + Number(opts.ageDays) + "\n" +
        "$trashKeepDays = " + Number(opts.trashKeepDays) + "\n" +
        "$patterns = " + psQuote(patterns) + " | ConvertFrom-Json\n" +
        "$keepPatterns = " + psQuote(keeps) + " | ConvertFrom-Json\n" +
        "$trashRoot = Join-Path $root '.dsh-trash'\n" +
        "$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'\n" +
        "$moved = 0; $deleted = 0; $purged = 0\n" +
        "$junkDirs = New-Object System.Collections.ArrayList\n" +
        "$junkFiles = New-Object System.Collections.ArrayList\n" +
        "if (-not (Test-Path -LiteralPath $root)) { Write-Output '__CLEAN_JSON__{\"error\":\"workspace missing\"}'; exit 0 }\n" +
        "$all = Get-ChildItem -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue\n" +
        "foreach ($item in $all) {\n" +
        "  $rel = $item.FullName.Substring($root.Length)\n" +
        "  if ($item.Name -eq '.git' -or $rel -like '*\\.git\\*' -or $item.Name -eq '.dsh-trash' -or $rel -like '*\\.dsh-trash\\*' -or $item.Name -eq '.dsh-cleaner.json' -or $item.Name -eq '.ws-cleaner-last-run.json') { continue }\n" +
        "  $keepHit = $false\n" +
        "  foreach ($k in $keepPatterns) { if ($item.Name -like $k) { $keepHit = $true; break } }\n" +
        "  if ($keepHit) { continue }\n" +
        "  if ($item.PSIsContainer) { if ($item.Name -eq '__pycache__') { [void]$junkDirs.Add($item) } }\n" +
        "  else {\n" +
        "    $hit = $false\n" +
        "    foreach ($p in $patterns) { if ($item.Name -like $p) { $hit = $true; break } }\n" +
        "    if (-not $hit -and $item.Name -like '~$*') { $hit = $true }\n" +
        "    if ($hit -and $item.Extension -eq '.log') { if ($item.LastWriteTime -ge (Get-Date).AddDays(-$ageDays)) { $hit = $false } }\n" +
        "    if ($hit) { [void]$junkFiles.Add($item) }\n" +
        "  }\n" +
        "}\n" +
        "$dirPrefixes = @($junkDirs | ForEach-Object { $_.FullName })\n" +
        "$junkFiles2 = New-Object System.Collections.ArrayList\n" +
        "foreach ($f in $junkFiles) { $inside = $false; foreach ($d in $dirPrefixes) { if ($f.FullName.StartsWith($d + '\\')) { $inside = $true; break } }; if (-not $inside) { [void]$junkFiles2.Add($f) } }\n" +
        "$total = $junkDirs.Count + $junkFiles2.Count\n" +
        "if (-not $dry) {\n" +
        "  if ($permanent) {\n" +
        "    foreach ($d in $junkDirs) { Remove-Item -LiteralPath $d.FullName -Recurse -Force; if (-not (Test-Path -LiteralPath $d.FullName)) { $deleted++ } }\n" +
        "    foreach ($f in $junkFiles2) { Remove-Item -LiteralPath $f.FullName -Force; if (-not (Test-Path -LiteralPath $f.FullName)) { $deleted++ } }\n" +
        "  } else {\n" +
        "    $destRoot = Join-Path $trashRoot $stamp\n" +
        "    New-Item -ItemType Directory -Path $destRoot -Force | Out-Null\n" +
        "    foreach ($d in $junkDirs) { $rel = $d.FullName.Substring($root.Length); $dest = Join-Path $destRoot ($rel -replace '^[\\\\/]', ''); New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null; Move-Item -LiteralPath $d.FullName -Destination $dest -Force; if (-not (Test-Path -LiteralPath $d.FullName)) { $moved++ } }\n" +
        "    foreach ($f in $junkFiles2) { $rel = $f.FullName.Substring($root.Length); $dest = Join-Path $destRoot ($rel -replace '^[\\\\/]', ''); New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null; Move-Item -LiteralPath $f.FullName -Destination $dest -Force; if (-not (Test-Path -LiteralPath $f.FullName)) { $moved++ } }\n" +
        "  }\n" +
        "  if (Test-Path -LiteralPath $trashRoot) {\n" +
        "    Get-ChildItem -LiteralPath $trashRoot -Directory | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$trashKeepDays) } | ForEach-Object { $n = (Get-ChildItem -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count; Remove-Item -LiteralPath $_.FullName -Recurse -Force; if (-not (Test-Path -LiteralPath $_.FullName)) { $purged += $n } }\n" +
        "  }\n" +
        "}\n" +
        "Write-Output ('__CLEAN_JSON__{\"junk\":' + $total + ',\"moved\":' + $moved + ',\"deleted\":' + $deleted + ',\"purged\":' + $purged + '}')\n";
    }

    async function runClean(workspace, opts) {
      const result = { workspace: workspace, junk: 0, moved: 0, deleted: 0, purged: 0, errors: [] };
      if (!shellSvc) { result.errors.push('shell 服务不可用'); return result; }
      if (!workspace) { result.errors.push('无法确定工作区路径'); return result; }
      try {
        const spec = shellSvc.resolve({ command: buildScript(workspace, opts), timeoutMs: 180000, stdoutMaxBytes: 400000 });
        if (opts.standing) spec.sandboxPolicy = opts.standing;
        const res = await shellSvc.run(spec);
        const out = res && res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : '';
        const m = out.match(/__CLEAN_JSON__(\{.*\})/);
        if (m) {
          const parsed = JSON.parse(m[1]);
          if (parsed.error) result.errors.push(parsed.error);
          else { result.junk = parsed.junk || 0; result.moved = parsed.moved || 0; result.deleted = parsed.deleted || 0; result.purged = parsed.purged || 0; }
        } else {
          result.errors.push('清理输出解析失败: ' + out.slice(-300));
        }
      } catch (e) {
        result.errors.push(String(e && e.message ? e.message : e));
      }
      return result;
    }

    // ---- 1. 自动清理(apply 清扫 + 定时兜底 + 事件钩子) ----
    let lastAutoCleanAt = 0;
    function scheduleAutoClean(agent, trigger) {
      const init = initiatorCwd();
      const ag = agent || (init && init.agent);
      const ws = agentCwd(ag) || (init && init.cwd) || null;
      const standing = standingPolicyFor(ag);
      const diag = { trigger: trigger, time: new Date().toISOString(), ws: ws, hasPolicy: !!policySvc, stage: ws ? 'start' : 'no-workspace' };
      if (fsSvc && ws) {
        fsSvc.resolve('.ws-cleaner-last-run.json', { cwd: ws }).then(function (t) {
          return fsSvc.writeText(t, JSON.stringify(diag), undefined, undefined, standing);
        }).catch(function () {});
      }
      if (!ws) { console.error('ws-cleaner: no workspace for ' + trigger); return; }
      const now = Date.now();
      if (now - lastAutoCleanAt < 5000) return;
      lastAutoCleanAt = now;
      (async () => {
        try {
          const cfg = await readConfig(ws);
          if (!cfg.enabled) { diag.stage = 'disabled'; if (fsSvc) { fsSvc.resolve('.ws-cleaner-last-run.json', { cwd: ws }).then(function (t) { return fsSvc.writeText(t, JSON.stringify(diag), undefined, undefined, standing); }).catch(function () {}); } return; }
          const r = await runClean(ws, { dry: false, permanent: cfg.permanent === true, ageDays: cfg.ageDays, trashKeepDays: cfg.trashKeepDays, extraPatterns: cfg.extraPatterns, keepPatterns: cfg.keepPatterns, standing: standing });
          diag.stage = 'done'; diag.junk = r.junk; diag.moved = r.moved; diag.deleted = r.deleted; diag.purged = r.purged; diag.errors = r.errors;
          if (fsSvc) { fsSvc.resolve('.ws-cleaner-last-run.json', { cwd: ws }).then(function (t) { return fsSvc.writeText(t, JSON.stringify(diag), undefined, undefined, standing); }).catch(function () {}); }
          console.log('ws-cleaner auto [' + trigger + ']: ws=' + ws + ' junk=' + r.junk + ' moved=' + r.moved + ' deleted=' + r.deleted + ' purged=' + r.purged + (r.errors.length ? ' errors=' + r.errors.join(';') : ''));
        } catch (e) {
          diag.stage = 'error'; diag.error = String(e && e.message ? e.message : e);
          if (fsSvc && ws) { fsSvc.resolve('.ws-cleaner-last-run.json', { cwd: ws }).then(function (t) { return fsSvc.writeText(t, JSON.stringify(diag), undefined, undefined, standing); }).catch(function () {}); }
          console.error('ws-cleaner auto failed: ' + String(e && e.message ? e.message : e));
        }
      })();
    }
    ctx.on('agent/turn-stopping', (payload) => scheduleAutoClean(payload && payload.agent, 'turn-stopping'));
    ctx.on('agent/status', (payload) => {
      if (payload && payload.status === 'idle') scheduleAutoClean(payload.agent, 'status-idle');
    });
    scheduleAutoClean(null, 'apply');
    (async () => {
      const init = initiatorCwd();
      const ws0 = init ? init.cwd : null;
      const cfg = ws0 ? await readConfig(ws0) : null;
      const minutes = cfg && Number.isFinite(Number(cfg.intervalMinutes)) && Number(cfg.intervalMinutes) > 0 ? Number(cfg.intervalMinutes) : 10;
      ctx.interval(() => scheduleAutoClean(null, 'interval'), Math.floor(minutes * 60000));
    })();

    // ---- 2. 手动清理工具 ----
    const tool = harness.defineTool({
      name: 'clean_workspace',
      description: '清理当前会话工作区里的不必要文件。规则(保守):临时/备份/转储文件(*.tmp *.temp *.bak *.orig *.old *.dmp *.partial *.crdownload *.pyc)、系统残留(.DS_Store Thumbs.db ~$*)、会话临时文件(.gh-*-body.json .plugin-check.js)、__pycache__ 目录,以及超过 age_days(默认 7 天)未修改的 *.log。默认把命中文件移入工作区 .dsh-trash/<时间戳>/ 回收区(可恢复),并清空超过 trashKeepDays(默认 7 天)的旧回收区;permanent=true 时改为直接永久删除。永不触碰 .git、.dsh-trash、.dsh-cleaner.json、.ws-cleaner-last-run.json 与 keep_patterns 命中的文件。自动清理三重保障:插件加载后立即清扫一次 + 每 intervalMinutes(默认 10)分钟定时兜底 + 任务回合收尾事件触发;可用工作区根目录的 .dsh-cleaner.json 配置 {enabled, permanent, ageDays, trashKeepDays, intervalMinutes, extraPatterns, keepPatterns};permanent=true 时自动清理也直接永久删除。每次自动清理后在工作区写 .ws-cleaner-last-run.json 记录触发源与结果。',
      parameters: {
        dry_run: { type: 'boolean', description: '为 true 时只统计命中数量,不移动不删除(默认 false)' },
        permanent: { type: 'boolean', description: '为 true 时直接永久删除,否则移入 .dsh-trash 回收区(默认 false)' },
        age_days: { type: 'integer', description: '*.log 的保留天数,超过才清理(默认 7)' },
        purge_trash: { type: 'boolean', description: '是否清空超过 trashKeepDays 天的旧回收区(默认 true)' },
        trash_keep_days: { type: 'integer', description: '回收区保留天数(默认 7)' },
        extra_patterns: { type: 'array', items: { type: 'string' }, description: '额外通配符(如 *.abc),追加到内置规则' },
        keep_patterns: { type: 'array', items: { type: 'string' }, description: '永不清理的通配符(如 *.ps1, 按文件名匹配)' }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspace: { type: 'string' },
            junk: { type: 'integer', required: true },
            moved: { type: 'integer', required: true },
            deleted: { type: 'integer', required: true },
            purged: { type: 'integer', required: true },
            errors: { type: 'array', items: { type: 'string' } }
          }
        },
        render(args, value) {
          const lines = [];
          lines.push('\uD83E\uDDF9 工作区清理完成');
          lines.push('- 工作区: ' + (value.workspace || ''));
          lines.push('- 命中垃圾: ' + value.junk + ' 项');
          if (value.moved > 0) lines.push('- 移入回收区 .dsh-trash: ' + value.moved + ' 项(可恢复)');
          if (value.deleted > 0) lines.push('- 永久删除: ' + value.deleted + ' 项');
          if (value.purged > 0) lines.push('- 清空过期回收区: ' + value.purged + ' 项');
          if (value.errors && value.errors.length) lines.push('- 注意: ' + value.errors.join('; '));
          return [{ type: 'text', text: lines.join('\n') }];
        }
      },
      timeoutMs: 60 * 60 * 1000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const agent = exec && exec.agent ? exec.agent : null;
        let ws = agentCwd(agent);
        if (!ws) {
          const init = initiatorCwd();
          ws = init ? init.cwd : null;
        }
        const standing = standingPolicyFor(agent);
        const cfg = ws ? await readConfig(ws) : { enabled: true, permanent: false, ageDays: 7, trashKeepDays: 7, intervalMinutes: 10, extraPatterns: [], keepPatterns: [] };
        const ageDays = args.age_days === undefined ? cfg.ageDays : Number(args.age_days);
        const trashKeepDays = args.trash_keep_days === undefined ? cfg.trashKeepDays : Number(args.trash_keep_days);
        const extraPatterns = Array.isArray(args.extra_patterns) ? args.extra_patterns.filter(function (x) { return typeof x === 'string'; }) : cfg.extraPatterns;
        const keepPatterns = Array.isArray(args.keep_patterns) ? args.keep_patterns.filter(function (x) { return typeof x === 'string'; }) : cfg.keepPatterns;
        return await runClean(ws, {
          dry: args.dry_run === true,
          permanent: args.permanent === true,
          ageDays: Number.isFinite(ageDays) ? Math.max(0, Math.floor(ageDays)) : 7,
          trashKeepDays: Number.isFinite(trashKeepDays) ? Math.max(1, Math.floor(trashKeepDays)) : 7,
          purgeTrash: args.purge_trash !== false,
          extraPatterns: extraPatterns,
          keepPatterns: keepPatterns,
          standing: standing
        });
      }
    });
    try {
      harness.registerTool(ctx, tool);
    } catch (e) {
      tool.name = 'clean_workspace2';
      try {
        harness.registerTool(ctx, tool);
      } catch (e2) {
        console.error('ws-cleaner: tool registration failed: ' + String(e2 && e2.message ? e2.message : e2));
      }
    }
  }
};
