<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { uiState } from '../ui-state.ts';

/**
 * Diagramme Mermaid agrandi : plein écran, zoom (molette centrée sur le curseur, boutons, + / - / 0),
 * déplacement en glissant, ajustement à la fenêtre. Le SVG est celui déjà rendu dans le chat.
 */
const { t } = useI18n();
const stage = ref<HTMLElement | null>(null);
const scale = ref(1);
const x = ref(0);
const y = ref(0);
const size = ref({ w: 0, h: 0 });
const MIN = 0.1;
const MAX = 8;

const svg = computed(() => {
  const raw = uiState.diagram;
  if (!raw) return '';
  // Taille naturelle d'après la viewBox ; le style max-width de Mermaid est retiré pour zoomer librement.
  const vb = /viewBox="[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(raw);
  size.value = vb ? { w: Number(vb[1]), h: Number(vb[2]) } : { w: 800, h: 600 };
  return raw.replace(/<svg([^>]*?)\sstyle="[^"]*"/, '<svg$1').replace(/<svg/, `<svg width="${size.value.w}" height="${size.value.h}"`);
});

function fit() {
  const el = stage.value;
  if (!el || !size.value.w) return;
  const s = Math.min(MAX, Math.max(MIN, Math.min(el.clientWidth / size.value.w, el.clientHeight / size.value.h) * 0.92));
  scale.value = s;
  x.value = (el.clientWidth - size.value.w * s) / 2;
  y.value = (el.clientHeight - size.value.h * s) / 2;
}

/** Zoom autour d'un point de l'écran (le point sous le curseur reste immobile). */
function zoomAt(factor: number, cx?: number, cy?: number) {
  const el = stage.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const px = cx === undefined ? r.width / 2 : cx - r.left;
  const py = cy === undefined ? r.height / 2 : cy - r.top;
  const next = Math.min(MAX, Math.max(MIN, scale.value * factor));
  const k = next / scale.value;
  x.value = px - (px - x.value) * k;
  y.value = py - (py - y.value) * k;
  scale.value = next;
}
function actualSize() {
  zoomAt(1 / scale.value);
}

function onWheel(e: WheelEvent) {
  e.preventDefault();
  zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
}

let drag: { x: number; y: number; ox: number; oy: number } | null = null;
function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  drag = { x: e.clientX, y: e.clientY, ox: x.value, oy: y.value };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onPointerMove(e: PointerEvent) {
  if (!drag) return;
  x.value = drag.ox + e.clientX - drag.x;
  y.value = drag.oy + e.clientY - drag.y;
}
function onPointerUp() {
  drag = null;
}

function close() {
  uiState.diagram = null;
}
function onKey(e: KeyboardEvent) {
  if (!uiState.diagram) return;
  if (e.key === 'Escape') close();
  else if (e.key === '+' || e.key === '=') zoomAt(1.25);
  else if (e.key === '-') zoomAt(0.8);
  else if (e.key === '0') fit();
  else return;
  e.preventDefault();
  e.stopPropagation();
}

watch(
  () => uiState.diagram,
  async (d) => {
    if (d) {
      window.addEventListener('keydown', onKey, true);
      await nextTick();
      fit();
      stage.value?.focus();
    } else window.removeEventListener('keydown', onKey, true);
  },
);
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true));
</script>

<template>
  <Teleport to="body">
    <div v-if="uiState.diagram" class="viewer" role="dialog" aria-modal="true" :aria-label="t('diagram.title')">
      <div class="bar">
        <span class="title"><i class="pi pi-sitemap" /> {{ t('diagram.title') }}</span>
        <div class="tools">
          <button type="button" class="mh-icon-btn" :aria-label="t('diagram.zoomOut')" v-tooltip.bottom="`${t('diagram.zoomOut')} (-)`" @click="zoomAt(0.8)"><i class="pi pi-search-minus" /></button>
          <button type="button" class="pct" :aria-label="t('diagram.actualSize')" v-tooltip.bottom="t('diagram.actualSize')" @click="actualSize">{{ Math.round(scale * 100) }} %</button>
          <button type="button" class="mh-icon-btn" :aria-label="t('diagram.zoomIn')" v-tooltip.bottom="`${t('diagram.zoomIn')} (+)`" @click="zoomAt(1.25)"><i class="pi pi-search-plus" /></button>
          <button type="button" class="mh-icon-btn" :aria-label="t('diagram.fit')" v-tooltip.bottom="`${t('diagram.fit')} (0)`" @click="fit"><i class="pi pi-expand" /></button>
          <button type="button" class="mh-icon-btn" :aria-label="t('common.close')" v-tooltip.bottom="t('diagram.close')" @click="close"><i class="pi pi-times" /></button>
        </div>
      </div>
      <div ref="stage" class="stage" tabindex="-1" @wheel="onWheel" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp" @dblclick="fit">
        <!-- eslint-disable-next-line vue/no-v-html -- SVG produit par Mermaid (niveau de sécurité strict), déjà affiché dans le chat -->
        <div class="canvas" :style="{ transform: `translate(${x}px, ${y}px) scale(${scale})` }" v-html="svg" />
      </div>
      <p class="hint">{{ t('diagram.hint') }}</p>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--mh-bg) 94%, transparent);
  backdrop-filter: blur(4px);
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  border-bottom: 1px solid var(--mh-border);
  background: var(--mh-surface);
}
.title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.tools {
  display: flex;
  align-items: center;
  gap: 4px;
}
.pct {
  min-width: 64px;
  border: 1px solid var(--mh-border);
  border-radius: 6px;
  background: transparent;
  padding: 3px 8px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.stage {
  flex: 1;
  position: relative;
  overflow: hidden;
  cursor: grab;
  outline: none;
  touch-action: none;
}
.stage:active {
  cursor: grabbing;
}
.canvas {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
}
.hint {
  margin: 0;
  padding: 6px 14px;
  font-size: 12px;
  color: var(--mh-muted);
  text-align: center;
}
</style>
