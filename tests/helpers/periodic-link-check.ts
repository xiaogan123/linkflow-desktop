import {inspectRecheckedLinkHtml} from '../../src/integrations/web';
import type {ControllerServices} from '../../src/main/controller';

/** Reuse a platform's fixture transport for the periodic public HTML GET. */
export function periodicFixtureCheck(request:(url:string,init:RequestInit)=>Promise<Response>):NonNullable<ControllerServices['recheckLink']>{
  return async (url,target,legacy)=>{
    try{
      const response=await request(url,{method:'GET'});
      if(!response.ok)return {found:false,outcome:'unreachable',url,rel:'',reason:'fixture page unavailable',reasonCode:'page_http_error'};
      return inspectRecheckedLinkHtml(await response.text(),url,target,legacy,response.headers.get('x-robots-tag')??'');
    }catch{
      return {found:false,outcome:'unreachable',url,rel:'',reason:'fixture page unavailable',reasonCode:'page_unreachable'};
    }
  };
}
