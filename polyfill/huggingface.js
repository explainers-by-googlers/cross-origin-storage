import {
  pipeline,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.3.3';
import { getBlobHash } from './util.js';
import './cos-polyfill.js';

const cachedFileHashesLocalStorageKey = 'cached-file-hashes';
const cachedFileHashes = JSON.parse(
  localStorage.getItem(cachedFileHashesLocalStorageKey) ?? '{}',
);

env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = {
  match: async (request) => {
    console.log('cosCache.match', request);
    request = request
      .replace('https://huggingface.co', '')
      .replace(/^\/models/, '');
    const hashValue = cachedFileHashes[request];
    if (!hashValue) {
      console.log('cosCache.match MISS', request);
      return undefined;
    }

    const hash = { algorithm: 'SHA-256', value: hashValue };
    try {
      const [handle] = await navigator.crossOriginStorage.requestFileHandles([
        hash,
      ]);
      console.log('cosCache.match HIT', request, hashValue);
      return new Response(await handle.getFile());
    } catch (err) {
      console.error(err.name, err.message);
      return undefined;
    }
  },
  put: async (request, response) => {
    console.log('cosCache.put', request, response);
    const blob = await response.blob();
    const hash = await getBlobHash(blob);
    request = request
      .replace('https://huggingface.co', '')
      .replace(/\/resolve\/main/, '');
    console.log('cosCache.put', request);
    cachedFileHashes[request] = hash.value;
    localStorage.setItem(
      cachedFileHashesLocalStorageKey,
      JSON.stringify(cachedFileHashes),
    );
    const [handle] = await navigator.crossOriginStorage.requestFileHandles(
      [hash],
      { create: true },
    );
    const writableStream = await handle.createWritable();
    await writableStream.write(blob);
    await writableStream.close();
  },
};

// Create automatic speech recognition pipeline
const transcriber = await pipeline(
  'automatic-speech-recognition',
  'onnx-community/whisper-tiny.en',
  { device: 'webgpu' },
);

// Transcribe audio from a URL
const url =
  'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const output = await transcriber(url);
document.body.append(JSON.stringify(output));
// { text: ' And so my fellow Americans ask not what your country can do for you, ask what you can do for your country.' }
