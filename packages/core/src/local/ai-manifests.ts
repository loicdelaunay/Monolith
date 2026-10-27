/**
 * Ressources épinglées de l'IA locale auxiliaire (mêmes versions que la v1) : révision, taille et
 * empreinte SHA-256 de chaque fichier. Rien n'est téléchargé sans l'accord de l'utilisateur.
 */
export interface PinnedFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ModelManifest {
  id: 'lancet' | 'minilm';
  version: string;
  /** Dépôt Hugging Face, révision figée et préfixe des fichiers dans le dépôt. */
  repo: string;
  revision: string;
  prefix: string;
  files: PinnedFile[];
}

/** LANCET Nano 0.4.3 : classifieur de risque des commandes shell (Apache-2.0 / MIT). */
export const LANCET_MANIFEST: ModelManifest = {
  id: 'lancet',
  version: '0.4.3',
  repo: 'fingerthief/lancet-nano',
  revision: '2450cfbea514baef810f4087d6d31854783f3d2e',
  prefix: 'bundle/',
  files: [
    { path: 'model/encoder-int8.onnx', size: 110550587, sha256: '4e7d6a53d27a7321a2638a4bf446301e8e343c51000963331469e3ab20aae2a4' },
    { path: 'model/head.npz', size: 4732426, sha256: '0dfbd5aa5a6891d05cd7bc364fa69bc662de77b11d93fa526ae863af1bac256e' },
    { path: 'model/vocab.json', size: 703051, sha256: '43bb485f4de0f2fd49b370bef4efab23ea3ab6d0019e72bdd9cec1436a6eaa2b' },
    { path: 'model/merges.txt', size: 294364, sha256: '5d346f84939a98df0cde902df7d60154b461cde1b90dc653ab9b81d74e752a4d' },
    { path: 'model/model.json', size: 1996, sha256: '85f6682e709a3dcfb59f2a9b3d79e83184a9deef0ef5f85f8912d369ae091b89' },
    { path: 'model/export.json', size: 1231, sha256: '2276cd2d2644024bb73db7a3e56636cc12a7226b049287a1d80f27f9641293ea' },
    { path: 'classify.py', size: 7414, sha256: 'ccff76b3842a56b06a0abba75ea432aaea8c278b8f900a0b9d5889ec14c00320' },
    { path: 'LICENSE.md', size: 2403, sha256: '04f6d7fe560287cfa8ddf07a4f4c762953f519d5a751f8d91bb0dd78ea787df0' },
    { path: 'MODEL-LICENSE.md', size: 2378, sha256: '58dead362837a67162c78729d5c2f4614ee0399bbbe5b109fe8b92d8256e0817' },
    { path: 'NOTICE.txt', size: 4872, sha256: '1b631b00a85f322591d801ba4e74f948228002c7120e88fae8a4ee6426048451' },
    { path: 'THIRD-PARTY-NOTICES.md', size: 6408, sha256: 'b492884a055bf4e61e94d9241e0cf3fa6c491e80d753728d7c7470cf6070c4b5' },
    { path: 'licenses/Apache-2.0.txt', size: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' },
    { path: 'licenses/CodeT5-BSD-3-Clause.txt', size: 1481, sha256: 'd9d01e877963904b9c62f38bacb7237191a8ce069d3a0be4f2418a5f6153a577' },
    { path: 'licenses/MIT.txt', size: 1036, sha256: '508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1' },
    { path: 'licenses/pi-jev-guard-MIT.txt', size: 1073, sha256: '41384dc5cf15ef69653ce54c918e0e90e6771eec108ab080ab02021f56b07ebe' },
  ],
};

/** paraphrase-multilingual-MiniLM-L12-v2 (export ONNX quantifié Xenova, Apache-2.0) : 384 dimensions. */
export const MINILM_MANIFEST: ModelManifest = {
  id: 'minilm',
  version: 'paraphrase-multilingual-MiniLM-L12-v2',
  repo: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  prefix: '',
  files: [
    { path: 'onnx/model_quantized.onnx', size: 118308126, sha256: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc' },
    { path: 'tokenizer.json', size: 17082913, sha256: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441' },
  ],
};

/** Python autonome (python-build-standalone) : version, publication et empreinte par plateforme. */
export const PYTHON_RUNTIME = {
  version: '3.13.15',
  release: '20260901',
  targets: {
    'win32-x64': { triple: 'x86_64-pc-windows-msvc', sha256: '9bcc038a0bf180612ed56dec93d4977d035e80b8d9320ef51a38c287baf134b7' },
    'win32-arm64': { triple: 'aarch64-pc-windows-msvc', sha256: 'ce87247378f43f88e0202a0fa6d3cdb5f5fb246a3bc61b2fb604bd49b7862508' },
    'darwin-x64': { triple: 'x86_64-apple-darwin', sha256: '49f0d97f506b855eed60b74a8ac138595c5b39799a6aa5e0d7ca8abe1019a4d4' },
    'darwin-arm64': { triple: 'aarch64-apple-darwin', sha256: 'b9054a9d3d54f4cb5573d44907fddb29874b08909bde73f29f2868cf872223ee' },
    'linux-x64': { triple: 'x86_64-unknown-linux-gnu', sha256: '0651dd7157d3debf769e15a52c1de9de7fbcdc36ba72faf79fde3c44f14d9461' },
  } as Record<string, { triple: string; sha256: string }>,
};

/** Dépendances CPU (roues binaires uniquement), communes aux deux modèles. */
export const PYTHON_DEPENDENCIES = ['numpy==2.2.6', 'tokenizers==0.22.2', 'onnxruntime==1.23.2'];
