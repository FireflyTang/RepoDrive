'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const defaults={repository:'',branch:'main',rootPath:'',proxy:'',tokenEncrypted:''};
function savedPath(){return path.join(app.getPath('userData'),'settings.json');}
function preset(){try{const value=JSON.parse(fs.readFileSync(path.join(app.getAppPath(),'repodrive.config.json'),'utf8'));return value.repository&&value.repository!=='OWNER/REPOSITORY'?value:null;}catch{return null;}}
function read(){let stored={};try{stored=JSON.parse(fs.readFileSync(savedPath(),'utf8'));}catch{}const initial=preset();return{...defaults,...(initial?{repository:initial.repository,branch:initial.branch||'main',rootPath:initial.rootPath||'',proxy:initial.proxy||''}:{}),...stored};}
function publicSettings(){const data=read();return{repository:data.repository,branch:data.branch,rootPath:data.rootPath,proxy:data.proxy,hasToken:Boolean(data.tokenEncrypted)};}
function token(){const value=read().tokenEncrypted;if(!value)return'';try{return safeStorage.decryptString(Buffer.from(value,'base64'));}catch{return'';}}
function save(next){const current=read();const tokenEncrypted=next.token?safeStorage.encryptString(next.token).toString('base64'):(next.clearToken?'':current.tokenEncrypted);const data={repository:next.repository,branch:next.branch,rootPath:next.rootPath,proxy:next.proxy,tokenEncrypted};fs.mkdirSync(path.dirname(savedPath()),{recursive:true});fs.writeFileSync(savedPath(),JSON.stringify(data,null,2),{mode:0o600});return publicSettings();}
module.exports={publicSettings,token,save};
