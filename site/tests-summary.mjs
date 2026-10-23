import assert from 'node:assert/strict';import{checkSummary,summaryPrompt}from'./src/summary-check.ts';
const samples=[{name:'steam_players_online',labels:{game:'Dota 2',appid:'570'},value:612345},{name:'steam_players_online',labels:{game:'Counter-Strike 2',appid:'730'},value:1234567}];
const checks=[{name:'Metric exists',status:'pass',message:'2 samples exposed'},{name:'Units',status:'unknown',message:'Not verifiable from text'}];
assert.match(summaryPrompt('steam_players_online',samples,checks,'live'),/612345/);
assert.equal(checkSummary('Counter-Strike 2 has 1,234,567 players and Dota 2 has 612345. Units remain unknown.',samples,checks).ok,true);
assert.deepEqual(checkSummary('Dota 2 has 700,000 players. Units unknown.',samples,checks).unknown,['700000'],'invented value flagged');
assert.deepEqual(checkSummary('Dota 2 has 612345 players.',samples,checks).missed,['Units'],'omitted non-pass check flagged');
console.log('summary-check: exact values accepted, invented numbers and omitted failing checks flagged');
