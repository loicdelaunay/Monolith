/**
 * Programmes Python lancés par `python -I -B -u -c <programme> <dossier du modèle> <dépendances>` :
 * une ligne `{"ready": true}` puis une réponse JSON par requête (identifiant renvoyé tel quel).
 */

/** LANCET Nano : classe une commande (texte inerte, jamais exécutée). Même pont que la v1. */
export const LANCET_BRIDGE = `
import importlib.util, json, pathlib, sys
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
folder = pathlib.Path(sys.argv[1])
sys.path.insert(0, sys.argv[2])
spec = importlib.util.spec_from_file_location('monolith_lancet', folder / 'classify.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
predictor = module.LancetNano(folder / 'model', threads=2)
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    row = {}
    try:
        row = json.loads(line)
        result = predictor.score(row['command'], row['shell'])
    except Exception:
        result = {'classification': 'review', 'score': None, 'reason': 'inference-error'}
    result['request_id'] = row.get('request_id')
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
`;

/** MiniLM multilingue : pooling moyen, normalisation L2, 384 dimensions, fenêtre de 128 tokens. */
export const EMBEDDINGS_BRIDGE = `
import json, pathlib, sys
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
folder = pathlib.Path(sys.argv[1])
sys.path.insert(0, sys.argv[2])
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer
tokenizer = Tokenizer.from_file(str(folder / 'tokenizer.json'))
tokenizer.enable_truncation(max_length=128)
tokenizer.enable_padding(pad_id=1, pad_token='<pad>')
options = ort.SessionOptions()
options.intra_op_num_threads = 2
session = ort.InferenceSession(str(folder / 'onnx' / 'model_quantized.onnx'), options, providers=['CPUExecutionProvider'])
names = {i.name for i in session.get_inputs()}
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    row = {}
    try:
        row = json.loads(line)
        encoded = tokenizer.encode_batch(row['texts'])
        ids = np.array([e.ids for e in encoded], dtype=np.int64)
        mask = np.array([e.attention_mask for e in encoded], dtype=np.int64)
        feed = {'input_ids': ids, 'attention_mask': mask}
        if 'token_type_ids' in names:
            feed['token_type_ids'] = np.zeros_like(ids)
        hidden = session.run(None, feed)[0]
        weights = mask[..., None].astype(np.float32)
        vectors = (hidden * weights).sum(axis=1) / np.clip(weights.sum(axis=1), 1e-9, None)
        vectors = vectors / np.clip(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-12, None)
        result = {'vectors': np.round(vectors, 6).tolist()}
    except Exception as error:
        result = {'error': str(error)[:300]}
    result['request_id'] = row.get('request_id')
    print(json.dumps(result), flush=True)
`;

/** Vérifie que les dépendances se chargent (après installation). */
export const DEPENDENCIES_CHECK = `
import sys
sys.path.insert(0, sys.argv[1])
import numpy, tokenizers, onnxruntime
print('ok')
`;
