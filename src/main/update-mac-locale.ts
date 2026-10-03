const macUpdateUtf8Locale='en_US.UTF-8';

export function macUpdateUtf8Environment(environment:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  return {...environment,LANG:macUpdateUtf8Locale,LC_ALL:macUpdateUtf8Locale,LC_CTYPE:macUpdateUtf8Locale};
}
