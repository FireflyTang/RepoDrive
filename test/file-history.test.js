'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {listByRecentCommit}=require('../src/file-history');
test('newest file precedes older folder; Unicode paths and branch snapshots are encoded, dates cached',async()=>{
 let head='first';let queries=0;
 const service={getConfig:()=>({owner:'o',repo:'r',branch:'files/main'}),request:async(path)=>{
  if(path.includes('/git/ref/'))return {object:{sha:head}};
  if(path.includes('/contents'))return [{name:'older',path:'older',type:'dir'},{name:'中文 #.zip',path:'中文 #.zip',type:'file'}];
  const url=new URL('https://api.github.com'+path); assert.equal(url.searchParams.get('sha'),head);queries++;
  return [{commit:{committer:{date:url.searchParams.get('path')==='older'?'2026-01-01T00:00:00Z':'2026-10-19T00:00:00Z'}}}];
 }};
 assert.deepEqual((await listByRecentCommit(service)).map(x=>x.name),['中文 #.zip','older']);
 await listByRecentCommit(service);assert.equal(queries,2);
 head='second';await listByRecentCommit(service);assert.equal(queries,4);
});
test('date lookup errors propagate rather than silently claiming correct sorting',async()=>{
 const service={getConfig:()=>({owner:'o',repo:'r',branch:'main'}),request:async p=>{
  if(p.includes('/git/ref/'))return {object:{sha:'head'}};
  if(p.includes('/contents'))return [{name:'a',path:'a'}];
  throw new Error('rate limit');
 }};await assert.rejects(listByRecentCommit(service),/rate limit/);
});
test('missing root after clearing displays an empty disk, not a failed connection',async()=>{
 const service={getConfig:()=>({owner:'o',repo:'r',branch:'main'}),request:async p=>{
  if(p.includes('/git/ref/'))return {object:{sha:'head'}};
  if(p.includes('/contents'))throw Object.assign(new Error('not found'),{status:404});
  if(p.includes('/git/commits/'))return {tree:{sha:'empty'}};
  return {tree:[]};
 }};assert.deepEqual(await listByRecentCommit(service),[]);assert.deepEqual(await listByRecentCommit(service,'old/root'),[]);
});
