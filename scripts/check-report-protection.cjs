'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module');
async function verifyReportProtection(root=path.join(__dirname,'..')) {
 const {ESLint}=require('eslint'),globals=require('globals');
 const filename=path.join(root,'src/native/cost-report/png.js'),req=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8')+'\nmodule.exports.serializedRenderPages=renderPages;module.exports.renderPdfForTest=renderPdf;',{
  module,exports:module.exports,require:req,Buffer,process,__dirname:path.dirname(filename)
 });
 const functions=[module.exports.serializedRenderPages,require(path.join(root,'src/native/cost-report/page-look.js')).finishReportPage,require(path.join(root,'src/native/cost-report/font-check.js')).checkReportFonts];
 const eslint=new ESLint({overrideConfigFile:true,overrideConfig:{languageOptions:{ecmaVersion:2024,sourceType:'module',globals:globals.browser},rules:{'no-undef':'error'}}});
 for(const fn of functions){
  const messages=(await eslint.lintText('const exported = ('+fn.toString()+');'))[0].messages;
  assert.deepEqual(messages.map(m=>m.message),[],'Serialized report functions must have no references to the parent Node realm');
 }
 const finish=vm.runInNewContext('('+functions[1].toString()+')');
 let written=false;
 finish({getImageData:()=>({data:new Uint8ClampedArray(16*16*4).fill(255)}),createImageData:()=>({data:new Uint8ClampedArray(16*16*4)}),putImageData:()=>{written=true}},16,16,[]);
 assert.equal(written,true);
 const check=vm.runInNewContext('('+functions[2].toString()+')');
 check({nativeWps:true},[{embedded:true}]);
 assert.throws(()=>check({nativeWps:true},[{embedded:false}]),/WPS/);
 if (process.versions.electron) {
  const {BrowserWindow}=require('electron');
  const sourceWindow=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true}});
  let pdf;
  try { await sourceWindow.loadURL('data:text/html,<html><body><h1>Report rendering test</h1></body></html>');pdf=await sourceWindow.webContents.printToPDF({pageSize:'A4'}); }
  finally {sourceWindow.destroy();}
  const png=await module.exports.renderPdfForTest(pdf,{fonts:[],eastAsianFonts:[],notes:[],singlePage:false,nativeWps:false});
  assert.equal(png.subarray(1,4).toString(),'PNG');assert.ok(png.length>1000);
  console.log('PASS actual packaged PDF to PNG through isolated Chromium window',png.length);
 }
 console.log('PASS report protection: all serialized functions have no external bindings; fresh-realm page/font execution works');
 return true;
}
module.exports={verifyReportProtection};
if(require.main===module)verifyReportProtection(process.argv[2]).catch(e=>{console.error(e);process.exit(1)});
