// Blogger's documented REST route is not a macOS home directory. Normalize
// only this exact, case-sensitive public path for the home-path detector;
// credentials and the private terms policy still inspect the original bytes.
export function hasPersonalMacPath(text){
 const paths=text.replace(/\/(?:blogger\/v3\/)?users\/self\/blogs(?=\/|[\s'"`?#]|$)/g,'/public-blogger-api');
 return /\/Users\/(?!runner\/)[a-z0-9._-]+\//i.test(paths);
}
