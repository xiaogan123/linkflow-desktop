import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LinkSimple } from '@phosphor-icons/react';
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot=dirname(dirname(fileURLToPath(import.meta.url)));
const assetsDir=join(projectRoot,'assets');
const iconsetDir=join(assetsDir,'AppIcon.iconset');
await mkdir(iconsetDir,{recursive:true});
const svg=renderToStaticMarkup(createElement(LinkSimple,{size:1024,color:'#3564ff',weight:'duotone'}));
const svgBuffer=Buffer.from(svg);
await sharp(svgBuffer).resize(1024,1024).png().toFile(join(assetsDir,'icon.png'));
await sharp(svgBuffer).resize(36,36).png().toFile(join(assetsDir,'tray.png'));

const macIcons=[
  ['icon_16x16.png',16],['icon_16x16@2x.png',32],
  ['icon_32x32.png',32],['icon_32x32@2x.png',64],
  ['icon_128x128.png',128],['icon_128x128@2x.png',256],
  ['icon_256x256.png',256],['icon_256x256@2x.png',512],
  ['icon_512x512.png',512],['icon_512x512@2x.png',1024]
];
await Promise.all(macIcons.map(([name,size])=>
  sharp(svgBuffer).resize(size,size).png().toFile(join(iconsetDir,name))
));

// ICO supports PNG-compressed image entries on every currently supported Windows release.
const windowsSizes=[16,24,32,48,64,128,256];
const windowsImages=await Promise.all(windowsSizes.map(size=>
  sharp(svgBuffer).resize(size,size).png().toBuffer()
));
const header=Buffer.alloc(6);
header.writeUInt16LE(0,0);
header.writeUInt16LE(1,2);
header.writeUInt16LE(windowsImages.length,4);
let imageOffset=6+windowsImages.length*16;
const entries=windowsImages.map((image,index)=>{
  const entry=Buffer.alloc(16);
  const size=windowsSizes[index];
  entry.writeUInt8(size===256?0:size,0);
  entry.writeUInt8(size===256?0:size,1);
  entry.writeUInt8(0,2);
  entry.writeUInt8(0,3);
  entry.writeUInt16LE(1,4);
  entry.writeUInt16LE(32,6);
  entry.writeUInt32LE(image.length,8);
  entry.writeUInt32LE(imageOffset,12);
  imageOffset+=image.length;
  return entry;
});
await writeFile(join(assetsDir,'AppIcon.ico'),Buffer.concat([header,...entries,...windowsImages]));
