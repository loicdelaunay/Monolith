<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Button from 'primevue/button';
import Slider from 'primevue/slider';
import { useToast } from 'primevue/usetoast';
import { useConfirm } from 'primevue/useconfirm';
import type { AssetInfo, PixelAsset } from '@monolith/contracts';
import { api, errorMessage, host } from '../../api.ts';

const { t } = useI18n();
const toast = useToast();
const confirm = useConfirm();
const assets = ref<AssetInfo[]>([]);
const selected = ref<string | null>(null);
const content = ref<{ kind: 'svg' | 'pixel'; content: string } | null>(null);
const scale = ref(8);
const frame = ref(0);
const playing = ref(false);
const canvas = ref<HTMLCanvasElement | null>(null);
const fail = (e: unknown) => toast.add({ severity: 'error', summary: errorMessage(e), life: 6000 });

let off: (() => void) | null = null;
onMounted(async () => {
  assets.value = await api.call('assets.list').catch(() => []);
  if (!selected.value && assets.value[0]) selected.value = assets.value[0].name;
  off = api.on('assets.changed', ({ assets: a }) => {
    assets.value = a;
    if (selected.value && !a.some((x) => x.name === selected.value)) selected.value = a[0]?.name ?? null;
    else if (selected.value) void load(selected.value);
  });
});
onBeforeUnmount(() => {
  off?.();
  clearInterval(timer);
});

async function load(name: string | null) {
  content.value = null;
  frame.value = 0;
  if (!name) return;
  content.value = await api.call('assets.read', { name }).catch((e) => (fail(e), null));
}
watch(selected, load);

const pixel = computed<PixelAsset | null>(() => {
  if (content.value?.kind !== 'pixel') return null;
  try {
    return JSON.parse(content.value.content) as PixelAsset;
  } catch {
    return null;
  }
});
const svgUrl = computed(() => (content.value?.kind === 'svg' ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(content.value.content)))}` : ''));

// Aperçu du pixel art sur un canevas (sans lissage).
function draw() {
  const p = pixel.value;
  const c = canvas.value;
  if (!p || !c) return;
  const s = Math.max(1, Math.min(24, Math.floor(320 / Math.max(p.width, p.height))));
  c.width = p.width * s;
  c.height = p.height * s;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const rows = p.frames[frame.value % p.frames.length]!;
  const idx = '0123456789abcdefghijklmnopqrstuvwxyz';
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      g.fillStyle = p.palette[idx.indexOf(ch.toLowerCase())] ?? '#00000000';
      g.fillRect(x * s, y * s, s, s);
    }),
  );
}
watch([pixel, frame, canvas], draw, { flush: 'post' });
let timer: ReturnType<typeof setInterval> | undefined;
watch(playing, (v) => {
  clearInterval(timer);
  if (v && pixel.value) timer = setInterval(() => (frame.value = (frame.value + 1) % pixel.value!.frames.length), 1000 / pixel.value.fps);
});

async function exportSvg() {
  if (content.value?.kind !== 'svg' || !selected.value) return;
  await host.saveTextFile(`${selected.value}.svg`, content.value.content, [{ name: 'SVG', extensions: ['svg'] }]);
}
async function exportPng() {
  if (!selected.value || !content.value) return;
  try {
    let data: string;
    if (content.value.kind === 'pixel') data = (await api.call('assets.png', { name: selected.value, scale: scale.value, frame: frame.value })).dataBase64;
    else {
      // SVG rendu par le navigateur de l'interface, à l'échelle choisie.
      const img = new Image();
      img.src = svgUrl.value;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round((img.naturalWidth || 256) * (scale.value / 4)));
      c.height = Math.max(1, Math.round((img.naturalHeight || 256) * (scale.value / 4)));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      data = c.toDataURL('image/png').split(',')[1]!;
    }
    await host.saveBinaryFile(`${selected.value}.png`, data, [{ name: 'PNG', extensions: ['png'] }]);
  } catch (e) {
    fail(e);
  }
}
async function importSvg(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const name = file.name.replace(/\.svg$/i, '').replace(/[^\w.-]+/g, '-').slice(0, 80) || 'image';
    await api.call('assets.save', { name, kind: 'svg', content: await file.text() });
    selected.value = name;
  } catch (err) {
    fail(err);
  }
  (e.target as HTMLInputElement).value = '';
}
function remove(name: string) {
  confirm.require({
    header: t('studio.assets.deleteTitle', { name }),
    message: '',
    icon: 'pi pi-trash',
    rejectProps: { label: t('common.cancel'), severity: 'secondary', outlined: true },
    acceptProps: { label: t('studio.assets.delete'), severity: 'danger' },
    accept: () => api.call('assets.delete', { name }).catch(fail),
  });
}
const fileInput = ref<HTMLInputElement | null>(null);
</script>

<template>
  <div class="assets">
    <aside class="list">
      <Button :label="t('studio.assets.import')" icon="pi pi-upload" size="small" text @click="fileInput?.click()" />
      <input ref="fileInput" type="file" accept=".svg,image/svg+xml" hidden @change="importSvg" />
      <p v-if="!assets.length" class="mh-hint pad">{{ t('studio.assets.empty') }}</p>
      <button v-for="a in assets" :key="a.name" type="button" class="item" :class="{ active: a.name === selected }" @click="selected = a.name">
        <i class="pi" :class="a.kind === 'svg' ? 'pi-pencil' : 'pi-th-large'" />
        <span class="name">{{ a.name }}</span>
        <span class="mh-hint">{{ a.kind }}</span>
      </button>
    </aside>
    <section v-if="content && selected" class="view">
      <div class="stage">
        <img v-if="content.kind === 'svg'" :src="svgUrl" :alt="selected" class="svg" />
        <canvas v-else ref="canvas" class="px" />
      </div>
      <div v-if="pixel && pixel.frames.length > 1" class="mh-row wrap">
        <Button :label="playing ? t('studio.assets.pause') : t('studio.assets.play')" :icon="playing ? 'pi pi-pause' : 'pi pi-play'" size="small" text @click="playing = !playing" />
        <span class="mh-hint">{{ t('studio.assets.frame', { n: frame + 1, total: pixel.frames.length }) }}</span>
      </div>
      <div class="mh-field">
        <label id="as-scale">{{ t('studio.assets.scale', { value: content.kind === 'svg' ? scale / 4 : scale }) }}</label>
        <Slider v-model="scale" :min="1" :max="32" aria-labelledby="as-scale" />
      </div>
      <div class="mh-row wrap">
        <Button v-if="content.kind === 'svg'" :label="t('studio.assets.exportSvg')" icon="pi pi-download" size="small" severity="secondary" outlined @click="exportSvg" />
        <Button :label="t('studio.assets.exportPng')" icon="pi pi-image" size="small" severity="secondary" outlined @click="exportPng" />
        <span class="grow" />
        <Button :label="t('studio.assets.delete')" icon="pi pi-trash" size="small" text severity="danger" @click="remove(selected)" />
      </div>
    </section>
  </div>
</template>

<style scoped>
.assets {
  display: flex;
  gap: 12px;
  min-height: 320px;
  flex: 1;
}
.list {
  width: 200px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: auto;
}
.pad {
  padding: 8px;
}
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  background: none;
  color: var(--mh-text);
  padding: 6px 8px;
  border-radius: var(--mh-radius-sm);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  text-align: left;
}
.item:hover {
  background: var(--mh-hover);
}
.item.active {
  background: color-mix(in srgb, var(--mh-accent) 14%, transparent);
}
.name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.view {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.stage {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  border: 1px solid var(--mh-border);
  border-radius: var(--mh-radius);
  background: repeating-conic-gradient(color-mix(in srgb, var(--mh-text) 6%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px;
  padding: 12px;
}
.svg {
  max-width: 100%;
  max-height: 320px;
}
.px {
  image-rendering: pixelated;
}
.grow {
  flex: 1;
}
</style>
