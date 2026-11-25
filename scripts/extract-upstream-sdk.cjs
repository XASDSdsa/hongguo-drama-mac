'use strict';
const fs=require('node:fs'),path=require('node:path');
const {listPackage,extractFile}=require('@electron/asar');
const root=path.resolve(process.argv[2]);
const files=fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>path.join(x.parentPath,x.name));
const output=path.join(root,'extracted-sdk','hongguo-sdk-playback.exe');
// The upstream "zip" wraps the NSIS portable EXE, which wraps app-64.7z.
const {execFileSync}=require('node:child_process');
for (const file of files.filter(x=>/hongguo-downloader.*\.exe$/i.test(x))) {
 execFileSync('7z',['x','-y','-bd',file,'-o'+path.join(root,'portable')],{stdio:'pipe'});
}
const nested=fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()&&x.name.endsWith('.7z')).map(x=>path.join(x.parentPath,x.name));
for(const file of nested)execFileSync('7z',['x','-y','-bd',file,'-o'+path.join(root,'portable-app')],{stdio:'pipe'});
files.push(...fs.readdirSync(root,{recursive:true,withFileTypes:true}).filter(x=>x.isFile()).map(x=>path.join(x.parentPath,x.name)));
const helper=files.find(x=>path.basename(x)==='hongguo-sdk-playback.exe');
if(helper){fs.mkdirSync(path.dirname(output),{recursive:true});fs.copyFileSync(helper,output);console.log('Extracted verified portable SDK component',fs.statSync(output).size);process.exit(0);}
for(const archive of files.filter(x=>x.endsWith('app.asar'))){
 const entries=listPackage(archive).filter(x=>/sdk.*playback/i.test(x));
 console.log('SDK entries',entries);
 const entry=entries.find(x=>/win32-x64.*hongguo-sdk-playback\.exe$/i.test(x));
 if(entry){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,extractFile(archive,entry.replace(/^[/\\]+/,'')));console.log('Extracted SDK from ASAR');process.exit(0);}
}
console.log('Archive executables',files.filter(x=>/\.exe$|\.asar$/i.test(x)));
throw new Error('SDK not found in upstream release archive');
