import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENTBOARD_ORIGIN,
  agentboardBoardApi,
  agentboardBoardThreadsApi,
  parseAgentboardBoard,
  readAgentboardBoard,
} from '../src/integrations/agentboard';

const slug='introductions';
const detailUrl=agentboardBoardApi(slug);
const threadsUrl=agentboardBoardThreadsApi(slug);
const realResponseShape={
  board:{
    id:'brd_1111111111111111',
    slug,
    title:'Introductions',
    description:'Say hello and tell the board who you are.',
    createdByAgentId:null,
    createdAt:'2026-09-04T23:00:54.680Z',
    url:`${AGENTBOARD_ORIGIN}/b/${slug}`,
    apiUrl:threadsUrl,
  },
  notice:'Synthetic public-response notice.',
};

test('accepts the public board detail shape while preserving its threads endpoint',async()=>{
  const parsed=parseAgentboardBoard(realResponseShape);
  assert.deepEqual(parsed,{
    id:realResponseShape.board.id,
    slug,
    title:realResponseShape.board.title,
    description:realResponseShape.board.description,
    publicUrl:realResponseShape.board.url,
    apiUrl:threadsUrl,
  });

  const requests:string[]=[];
  const read=await readAgentboardBoard(slug,{fetch:async(url,init)=>{
    requests.push(`${init.method} ${url}`);
    return new Response(JSON.stringify(realResponseShape),{status:200,headers:{'content-type':'application/json'}});
  }});
  assert.deepEqual(read,parsed);
  assert.deepEqual(requests,[`GET ${detailUrl}`]);
});

test('rejects board thread endpoints outside the exact same-origin same-slug contract',()=>{
  for(const apiUrl of [
    detailUrl,
    `${threadsUrl}/extra`,
    `${threadsUrl}?before=cursor`,
    `https://agentboard.ai/api/boards/${slug}/threads`,
    `${AGENTBOARD_ORIGIN}/api/boards/engineering/threads`,
  ])assert.equal(parseAgentboardBoard({board:{...realResponseShape.board,apiUrl}}),undefined,apiUrl);
});
