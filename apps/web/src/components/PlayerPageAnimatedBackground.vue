<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { loadAnimatedBackgroundBytes } from '../platform/assets/animated-background-cache';

const props = defineProps<{ desktopSrc: string; mobileSrc: string; desktopOnly?: boolean; mobileOnly?: boolean }>();

type DecodedFrame = CanvasImageSource & { displayWidth: number; displayHeight: number; duration?: number; close(): void };
type AvifDecoder = {
  tracks: { ready: Promise<void>; selectedTrack?: { frameCount: number } };
  decode(options: { frameIndex: number }): Promise<{ image: DecodedFrame }>;
  close(): void;
};
type AvifDecoderConstructor = new (options: { data: ArrayBuffer; type: string }) => AvifDecoder;
type AvifWindow = Window & { ImageDecoder?: AvifDecoderConstructor };

const canvas = ref<HTMLCanvasElement>();
const ready = ref(false);
let generation = 0;
let decoder: AvifDecoder | undefined;
let frameTimer: ReturnType<typeof setTimeout> | undefined;
let mediaQuery: MediaQueryList | undefined;
let resizeListener: (() => void) | undefined;

function selectedSource(): string {
  return window.matchMedia('(max-width: 720px)').matches ? props.mobileSrc : props.desktopSrc;
}

function stopPlayback(): void {
  generation++;
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = undefined;
  decoder?.close();
  decoder = undefined;
  ready.value = false;
  const context = canvas.value?.getContext('2d');
  context?.clearRect(0, 0, canvas.value?.width ?? 0, canvas.value?.height ?? 0);
}

async function startPlayback(): Promise<void> {
  stopPlayback();
  const isMobile = window.matchMedia('(max-width: 720px)').matches;
  if ((props.desktopOnly && isMobile) || (props.mobileOnly && !isMobile)) return;
  const currentGeneration = generation;
  const Decoder = (window as AvifWindow).ImageDecoder;
  if (!Decoder) return;

  try {
    const activeDecoder = new Decoder({ data: await loadAnimatedBackgroundBytes(selectedSource()), type: 'image/avif' });
    decoder = activeDecoder;
    await activeDecoder.tracks.ready;
    const frameCount = activeDecoder.tracks.selectedTrack?.frameCount ?? 0;
    if (frameCount < 2 || currentGeneration !== generation) {
      activeDecoder.close();
      if (decoder === activeDecoder) decoder = undefined;
      return;
    }

    const drawNextFrame = async (frameIndex: number): Promise<void> => {
      if (currentGeneration !== generation) return;
      const result = await activeDecoder.decode({ frameIndex });
      if (currentGeneration !== generation) { result.image.close(); return; }
      const target = canvas.value;
      if (!target) { result.image.close(); return; }
      if (target.width !== result.image.displayWidth || target.height !== result.image.displayHeight) {
        target.width = result.image.displayWidth;
        target.height = result.image.displayHeight;
      }
      target.getContext('2d')?.drawImage(result.image, 0, 0, target.width, target.height);
      const duration = result.image.duration;
      result.image.close();
      ready.value = true;
      frameTimer = setTimeout(() => {
        void drawNextFrame((frameIndex + 1) % frameCount);
      }, duration && duration > 0 ? duration / 1000 : 200);
    };
    void drawNextFrame(0).catch(() => {
      if (currentGeneration === generation) stopPlayback();
    });
  } catch {
    // Keep the static WebP below visible when AVIF/WebCodecs decoding is unavailable.
    if (currentGeneration === generation) stopPlayback();
  }
}

watch(() => [props.desktopSrc, props.mobileSrc, props.desktopOnly, props.mobileOnly], () => { void startPlayback(); });

watch(ready, (isReady) => {
  canvas.value?.classList.toggle('ready', isReady);
});

if (typeof window !== 'undefined') {
  mediaQuery = window.matchMedia('(max-width: 720px)');
  resizeListener = () => { void startPlayback(); };
  mediaQuery.addEventListener('change', resizeListener);
}

void startPlayback();

onBeforeUnmount(() => {
  if (mediaQuery && resizeListener) mediaQuery.removeEventListener('change', resizeListener);
  stopPlayback();
});
</script>

<template>
  <canvas ref="canvas" class="scene-backdrop player-page-motion-backdrop" aria-hidden="true"></canvas>
</template>
