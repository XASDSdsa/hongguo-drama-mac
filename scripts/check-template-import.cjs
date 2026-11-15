'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
async function verifyTemplateImport(root = path.join(__dirname, '..')) {
  const { createTemplateStore } = require(path.join(root, 'src/native/cost-report/templates.js'));
  const { checkTemplate, fillCostReport, readCostReport } = require(path.join(root, 'src/native/cost-report/docx.js'));
  const { writeZip } = require(path.join(root, 'src/native/cost-report/zip.js'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-import-'));
  try {
    const p = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
    const cell = text => `<w:tc w:rsidR="001">${p(text)}</w:tc>`;
    const xml = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      '<w:tbl w:rsidR="002"><w:tr>' + ['序号','微 短 剧 名 称','集数和总时长','总投资额','演员总片酬占比'].map(cell).join('') +
      '</w:tr><w:tr>' + ['1','','','5万元','15%'].map(cell).join('') + '</w:tr></w:tbl>' + p('2026年11月15日') + '</w:body></w:document>';
    const original = writeZip([{name:'[Content_Types].xml',data:Buffer.from('<Types/>')}, {name:'word/document.xml',data:Buffer.from(xml)}]);
    assert.deepEqual(checkTemplate(original), [], 'DOCX table/cell attributes and header spacing are valid');
    const filled = fillCostReport(original, {name:'模板测试',episodes:'1集，共1分钟',total:'5万元',share:'15%',date:new Date(2026,10,15)});
    assert.equal(readCostReport(filled).name,'模板测试','Accepted template remains fillable');
    const files = ['测试一.docx','测试二.DOCX'].map(name => path.join(temporary,name));
    files.forEach(file => fs.writeFileSync(file,original));
    const invalid = path.join(temporary,'无效.docx');fs.writeFileSync(invalid,'not a DOCX');
    const store = createTemplateStore(path.join(temporary,'userdata'),checkTemplate);
    let pick = {canceled:false,filePaths:files};
    let focused = 0;
    const parent = {isDestroyed:()=>false,focus:()=>focused++};
    let handler;
    const main = fs.readFileSync(path.join(root,'main.js'),'utf8');
    const source = main.match(/ipcMain\.handle\('cost-report-template-pick',[\s\S]*?\n\}\);/)?.[0];
    assert.ok(source,'Template picker IPC is registered');
    vm.runInNewContext(source, {
      ipcMain:{handle:(_name,fn)=>{handler=fn;}},
      BrowserWindow:{fromWebContents:()=>parent},mainWindow:null,
      dialog:{showOpenDialog:async (owner,options)=>{
        assert.equal(owner,parent);assert.ok(options.filters[0].extensions.includes('docx'));
        if (pick instanceof Error) throw pick;
        return pick;
      }},costTemplates:()=>store,
    });
    const imported = await handler({sender:{}});
    assert.equal(imported.success,true);assert.equal(imported.added.length,2);assert.equal(imported.templates.length,2);
    assert.equal(imported.template.id,imported.added[0].id);assert.equal(focused,1);
    for(const item of imported.added) assert.ok(fs.readFileSync(store.file(item.id)).equals(original));
    assert.equal(createTemplateStore(path.join(temporary,'userdata'),checkTemplate).list().length,2,'Imported templates survive reopening');
    pick={canceled:true,filePaths:[]};assert.equal((await handler({sender:{}})).canceled,true);assert.equal(store.list().length,2);
    pick={canceled:false,filePaths:[invalid]};const rejected=await handler({sender:{}});
    assert.equal(rejected.success,false);assert.ok(rejected.error.includes('无效.docx'));assert.equal(store.list().length,2);
    pick=new Error('读取文件失败');assert.equal((await handler({sender:{}})).error,'读取文件失败');
    console.log('PASS template import: actual picker IPC, multiple DOCX, attributes/spacing, persisted bytes, cancellation and visible failure responses');
    return true;
  } finally { fs.rmSync(temporary,{recursive:true,force:true}); }
}
module.exports={verifyTemplateImport};
if(require.main===module)verifyTemplateImport().catch(error=>{console.error(error);process.exit(1);});
