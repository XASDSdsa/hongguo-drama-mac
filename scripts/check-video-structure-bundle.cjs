const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function verifyBundle(root,platform,arch){
 const target=platform+'-'+arch,bundle=path.join(root,'build/video-structure',target),file=path.join(bundle,'bundle.json');
 if(!fs.existsSync(file))throw Error('缺少内置结构化拆解运行时 '+target+'；请在对应构建机执行 npm run setup:structure，不能发布半成品运行时');
 const m=JSON.parse(fs.readFileSync(file));if(m.platform!==target||m.offlineSelfTest!==true)throw Error('结构化拆解运行时未通过本机离线自检');
 if(m.shotVerifierSelfTest!==true||m.versions?.opencv!=='4.11.0'||m.versions?.shot_algorithm!=='transnetv2-temporal-min2s-v1')throw Error('内置分镜校验算法版本过旧或尚未通过离线自检；请重新执行 npm run setup:structure');
 if(m.punctuationSelfTest!==true||m.versions?.sentence_boundary!=='ct_transformer_global'||!m.sha256?.['models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8/model.int8.onnx'])throw Error('内置整句标点未通过离线自检，请重新执行 npm run setup:structure');
 if(platform==='darwin'&&(!m.minimumMacOS||Number(m.minimumMacOS)>13))throw Error('结构化运行时尚未通过 macOS 13 兼容性检查');
 const exe=platform==='win32'?'.exe':'';
 for(const f of ['worker/hongguo-structure'+exe,'bin/sherpa-onnx-offline-source-separation'+exe,'models/transnetv2.pth','models/UVR-MDX-NET-Inst_HQ_3.onnx','models/silero_vad.onnx','models/sherpa-onnx-paraformer-zh-small-2024-03-09/model.int8.onnx','models/sherpa-onnx-paraformer-zh-small-2024-03-09/tokens.txt'])if(!m.sha256?.[f])throw Error('缺少结构化资源校验 '+f);
 for(const [f,hash] of Object.entries(m.sha256)){const full=path.resolve(bundle,f);if(!full.startsWith(bundle+path.sep))throw Error('资源路径无效');if(createHash('sha256').update(fs.readFileSync(full)).digest('hex')!==hash)throw Error('结构化资源校验失败 '+f);}
 return bundle;
}
module.exports={verifyBundle};
if(require.main===module){try{console.log('PASS '+verifyBundle(path.resolve(__dirname,'..'),process.platform,process.arch));}catch(e){console.error(e.message);process.exitCode=1;}}
