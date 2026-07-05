const BASE = 'http://localhost:3000';

async function log(msg){ console.log(new Date().toISOString(), msg); }

async function run(){
  const fs = await import('fs');
  const path = await import('path');
  const zipModule = await import('jszip');
  const JSZip = zipModule.default;

  try{
    await log('開始測試流程');

    // 1) 搜尋（範例：sodium）
    const q = 'sodium';
    const projectType = 'mod';
    await log(`搜尋: ${q} (project_type=${projectType})`);
    const sres = await fetch(`${BASE}/api/modrinth?type=search&q=${encodeURIComponent(q)}&limit=1&project_type=${encodeURIComponent(projectType)}`);
    if(!sres.ok) throw new Error(`search failed: ${sres.status}`);
    const sjson = await sres.json();
    if(!sjson.hits || sjson.hits.length === 0) throw new Error('no search hits');
    const proj = sjson.hits[0];
    await log(`找到專案: ${proj.title} (${proj.project_id})`);

    // 2) 版本查詢
    const targetVersion='1.21.1';
    const loader='Fabric';
    await log(`查詢版本: projectId=${proj.project_id}, gameVersion=${targetVersion}, loader=${loader}`);
    const vres = await fetch(`${BASE}/api/modrinth?type=versions&projectId=${encodeURIComponent(proj.project_id)}&gameVersion=${encodeURIComponent(targetVersion)}&loader=${encodeURIComponent(loader)}`);
    if(!vres.ok) throw new Error(`versions failed: ${vres.status}`);
    const vjson = await vres.json();
    if(!Array.isArray(vjson) || vjson.length===0) throw new Error('no versions found for target');
    const chosen = vjson[0];
    const fileEntry = (chosen.files && chosen.files[0]);
    if(!fileEntry || !fileEntry.url) throw new Error('no file url in version');
    const filename = fileEntry.filename || `${proj.title}.jar`;
    await log(`取得檔案: ${filename} -> ${fileEntry.url}`);

    // 3) 下載檔案
    await log('下載檔案中...');
    const fres = await fetch(fileEntry.url);
    if(!fres.ok) throw new Error(`file download failed: ${fres.status}`);
    const arrayBuffer = await fres.arrayBuffer();
    await log(`下載完成: ${arrayBuffer.byteLength} bytes`);

    // 4) 建立 ZIP
    await log('建立 ZIP');
    const zip = new JSZip();
    zip.file(filename, new Uint8Array(arrayBuffer));
    const content = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});

    const outDir = path.join(__dirname, '..', 'tmp');
    if(!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `test-${proj.project_id}.zip`);
    fs.writeFileSync(outPath, content);
    await log(`ZIP 已寫入: ${outPath} (大小 ${content.length} bytes)`);

    await log('測試流程完成');
    process.exit(0);
  }catch(err){
    console.error('ERROR:', err);
    process.exit(2);
  }
}

run();
