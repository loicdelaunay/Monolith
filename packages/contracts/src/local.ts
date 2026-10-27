// Modèles locaux : GGUF, catalogue Hugging Face, moteur llama.cpp.

export interface GgufMeta {
  architecture: string | null;
  name: string | null;
  contextLength: number | null;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  /** Modèle de discussion (Jinja) présent : nécessaire aux appels d'outils. */
  hasChatTemplate: boolean;
}

export interface LocalModel {
  /** Nom du fichier GGUF (identifiant utilisé comme modèle). */
  id: string;
  sizeBytes: number;
  sha256: string | null;
  repo: string | null;
  quant: string | null;
  meta: GgufMeta | null;
  addedAt: string;
}

export interface HardwareInfo {
  ramTotalMb: number;
  ramFreeMb: number;
  cpus: number;
  cpuModel: string;
  gpus: { name: string; vramTotalMb: number; vramFreeMb: number; source: 'nvidia-smi' }[];
}

export interface ModelEstimate {
  weightsMb: number;
  kvCacheMb: number;
  overheadMb: number;
  totalMb: number;
  totalLayers: number | null;
  /** Couches proposées sur le GPU (0 : CPU seul). */
  gpuLayers: number;
  fits: 'gpu' | 'partial' | 'cpu' | 'too_large';
  note: string;
}

export interface HfModel {
  id: string;
  downloads: number;
  likes: number;
  updatedAt: string | null;
  gated: boolean;
}

export interface HfFile {
  name: string;
  size: number;
  sha256: string | null;
  quant: string | null;
  estimate: ModelEstimate | null;
}

export interface DownloadState {
  id: string;
  repo: string;
  file: string;
  total: number;
  received: number;
  status: 'running' | 'verifying' | 'done' | 'error' | 'cancelled';
  error: string | null;
  speedBps: number;
}

export interface LocalEngineInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
  source: 'download' | 'custom' | null;
  running: { model: string; port: number; contextSize: number; gpuLayers: number } | null;
}
