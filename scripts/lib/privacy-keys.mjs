// A PEM header in a parser or an output template is not itself a secret.
// Detect even a truncated body: no END marker or successful key parsing is required.
export function hasPrivateKeyMaterial(input) {
  const text = input
    .replace(/\\+(?:r\\+n|[rn]|x0[ad]|u000[ad])/gi, '\n')
    .replace(/\\+(['"`/])/g, '$1')
    // Join literal fragments only, never interpolate variables or execute source.
    .replace(/(['"`])(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\+(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*['"`]/g, '');
  const headers = new RegExp('-----BEGIN ' + '(?:[A-Z0-9]+ )?PRIVATE KEY-----', 'g');
  for (const header of text.matchAll(headers)) {
    let body = text.slice(header.index + header[0].length).trimStart();
    // Traditional encrypted PEM places these metadata lines before the body.
    while (/^(?:Proc-Type|DEK-Info):/i.test(body)) {
      const end = body.indexOf('\n');
      if (end < 0) {body = ''; break;}
      body = body.slice(end + 1).trimStart();
    }
    // Four Base64 characters suffice; incomplete keys still block publication.
    const payload = /^[A-Za-z0-9+/=\s]+/.exec(body)?.[0] ?? '';
    if (payload.replace(/\s/g, '').length >= 4) return true;
  }
  return false;
}
