// ws-cleaner — DSH dynamic Cordis plugin (Host half)
// 工作区垃圾文件自动/手动清理
//
// 加载方式(DSH 内):
//   1. cordis_define: code.host = 本文件全部内容(即函数体)
//   2. cordis_run 运行插件后,会话内即可调用工具 clean_workspace
// 依赖服务(Host): fs(可选,读配置)、shell(移动/删除)、timer、harness
//
// 注意: 本文件不含任何凭据。
//
// 版本: v2
//  - v1: clean_workspace 手动清理工具 + agent/turn-stopping 自动清理(移入回收区)
//  - v2: 自动清理改双信号触发(agent/turn-stopping + agent/status→idle,5 秒防抖、
//        不依赖定时器调度,修复上一轮未触发问题);新增 permanent 配置:
//        .dsh-cleaner.json 的 permanent=true 时自动清理直接永久删除(不进回收区)。
//
// 规则(保守):*.tmp *.temp *.bak *.orig *.old *.dmp *.partial *.crdownload *.pyc
//      .DS_Store Thumbs.db ~$* __pycache__ 目录,以及超过 ageDays(默认 7 天)的 *.log
// 永不触碰:.dsh-trash 本身、.git 目录、.dsh-cleaner.json 与 keepPatterns 命中的文件。
// 配置:工作区根目录可选 .dsh-cleaner.json
//      { "enabled": true, "permanent": false, "ageDays": 7, "trashKeepDays": 7,
//        "extraPatterns": ["*.abc"], "keepPatterns": ["*.ps1"] }

return {
  name: 'ws-cleaner',
  inject: ['timer'],
  apply(ctx) {
    const fsSvc = ctx.get('fs');
    const shellSvc = ctx.get('shell');
    const policySvc = ctx.get('sandboxPolicy');

    const DEFAULT_PATTERNS = ['*.tmp', '*.temp', '*.bak', '*.orig', '*.old', '*.dmp', '*.partial', '*.crdownload', '*.pyc', '.DS_Store', 'Thumbs.db'];

    function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

    async function readConfig(workspace) {
      const cfg = { enabled: true, permanent: false, ageDays: 7, trashKeepDays: 7, extraPatterns: [], keepPatterns: [] };
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
        "  if ($item.Name -eq '.git' -or $rel -like '*\\.git\\*' -or $item.Name -eq '.dsh-trash' -or $rel -like '*\\.dsh-trash\\*') { continue }\n" +
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
        const res = await shellSvc.run(spec);
        const out = res && res.stdout && typeof res.stdout.text === 'string' ? res.stdout.text : '';
        const m = out.match(/__CLEAN_JSON__\{(\{.*\})\}/);
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

    // ---- 1. 任务完成后自动清理(双信号 + 防抖) ----
    let lastAutoCleanAt = 0;
    function scheduleAutoClean(agent) {
      let ws = null;
      try { ws = agent && agent.session && agent.session.header ? agent.session.header.cwd : null; } catch (e) { ws = null; }
      if (!ws) return;
      const now = Date.now();
      if (now - lastAutoCleanAt < 5000) return;
      lastAutoCleanAt = now;
      (async () => {
        try {
          const cfg = await readConfig(ws);
          if (!cfg.enabled) return;
          const r = await runClean(ws, { dry: false, permanent: cfg.permanent === true, ageDays: cfg.ageDays, trashKeepDays: cfg.trashKeepDays, extraPatterns: cfg.extraPatterns, keepPatterns: cfg.keepPatterns });
          console.log('ws-cleaner auto: junk=' + r.junk + ' moved=' + r.moved + ' deleted=' + r.deleted + ' purged=' + r.purged + (r.errors.length ? ' errors=' + r.errors.join(';') : ''));
        } catch (e) {
          console.error('ws-cleaner auto failed: ' + String(e && e.message ? e.message : e));
        }
      })();
    }
    ctx.on('agent/turn-stopping', (payload) => scheduleAutoClean(payload && payload.agent));
    ctx.on('agent/status', (payload) => {
      if (payload && payload.status === 'idle') scheduleAutoClean(payload.agent);
    });

    // ---- 2. 手动清理工具 ----
    const tool = harness.defineTool({
      name: 'clean_workspace',
      description: '清理当前会话工作区里的不必要文件。规则(保守):临时/备份/转储文件(*.tmp *.temp *.bak *.orig *.old *.dmp *.partial *.crdownload *.pyc)、系统残留(.DS_Store Thumbs.db ~$*)、__pycache__ 目录,以及超过 age_days(默认 7 天)未修改的 *.log。默认把命中文件移入工作区 .dsh-trash/<时间戳>/ 回收区(可恢复),并清空超过 trashKeepDays(默认 7 天)的旧回收区;permanent=true 时改为直接永久删除。永不触碰 .git、.dsh-trash 自身与 keep_patterns 命中的文件。自动清理在每次任务回合收尾时按同样规则执行,可用工作区根目录的 .dsh-cleaner.json 配置 {enabled, permanent, ageDays, trashKeepDays, extraPatterns, keepPatterns};permanent=true 时自动清理也直接永久删除(不进回收区)。',
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
        let ws = null;
        try { ws = agent && agent.session && agent.session.header ? agent.session.header.cwd : null; } catch (e) { ws = null; }
        if (!ws && policySvc && typeof policySvc.workspaceRoot === 'string') ws = policySvc.workspaceRoot;
        const cfg = ws ? await readConfig(ws) : { enabled: true, permanent: false, ageDays: 7, trashKeepDays: 7, extraPatterns: [], keepPatterns: [] };
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
          keepPatterns: keepPatterns
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
