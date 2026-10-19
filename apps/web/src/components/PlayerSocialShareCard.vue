<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';

export type SocialShareCardData = {
  kind: 'PROFILE' | 'POST';
  title: string;
  subtitle: string;
  description: string;
  publicCode?: string;
  stats?: string;
  topic?: string;
  url: string;
};

const props = defineProps<{ data: SocialShareCardData }>();
const emit = defineEmits<{ close: [] }>();
const imageUrl = ref('');
const error = ref('');
const busy = ref(true);

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function drawWrapped(context: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number, maxLines: number): number {
  const words = [...text];
  let line = '';
  let lines = 0;
  for (const character of words) {
    const candidate = `${line}${character}`;
    if (line && context.measureText(candidate).width > maxWidth) {
      context.fillText(line, x, y + lines * lineHeight);
      lines += 1;
      line = character;
      if (lines >= maxLines) break;
    } else line = candidate;
  }
  if (lines < maxLines && line) { context.fillText(line, x, y + lines * lineHeight); lines += 1; }
  return lines;
}

async function imageFromDataUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('SHARE_IMAGE_LOAD_FAILED'));
    image.src = url;
  });
}

async function createPreview(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const qr = await import('qrcode');
    const [qrImage, canvas] = await Promise.all([
      imageFromDataUrl(await qr.toDataURL(props.data.url, { errorCorrectionLevel: 'M', margin: 1, width: 240 })),
      Promise.resolve(document.createElement('canvas')),
    ]);
    const width = 720;
    const height = props.data.kind === 'PROFILE' ? 960 : 900;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('SHARE_CANVAS_UNAVAILABLE');
    const background = context.createLinearGradient(0, 0, width, height);
    background.addColorStop(0, '#102522');
    background.addColorStop(1, '#392c1d');
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#d9b66c';
    context.lineWidth = 3;
    roundedRect(context, 24, 24, width - 48, height - 48, 32);
    context.stroke();
    context.textAlign = 'center';
    context.fillStyle = '#dfbd73';
    context.font = '600 24px system-ui, sans-serif';
    context.fillText('LOTTERY GAME · 牌友社区', width / 2, 88);
    context.fillStyle = '#f8efd9';
    context.font = '700 42px system-ui, sans-serif';
    context.fillText(props.data.title.slice(0, 24), width / 2, 170);
    context.fillStyle = '#d6d0bf';
    context.font = '26px system-ui, sans-serif';
    let y = 220 + drawWrapped(context, props.data.subtitle, width / 2, 220, 590, 38, 2) * 38;
    if (props.data.topic) {
      context.fillStyle = '#dfbd73';
      context.font = '600 24px system-ui, sans-serif';
      context.fillText(props.data.topic.slice(0, 28), width / 2, y + 22);
      y += 55;
    }
    context.fillStyle = '#d6d0bf';
    context.font = '25px system-ui, sans-serif';
    y += drawWrapped(context, props.data.description, width / 2, y + 12, 570, 38, 4) * 38;
    if (props.data.stats) {
      context.fillStyle = '#f2d58d';
      context.font = '700 27px system-ui, sans-serif';
      context.fillText(props.data.stats.slice(0, 42), width / 2, y + 28);
    }
    if (props.data.publicCode) {
      context.fillStyle = '#e6dcc3';
      context.font = '22px system-ui, sans-serif';
      context.fillText(`用户唯一码  ${props.data.publicCode}`, width / 2, height - 168);
    }
    const qrSize = 142;
    context.fillStyle = '#fff';
    roundedRect(context, (width - qrSize - 20) / 2, height - 150, qrSize + 20, qrSize + 20, 12);
    context.fill();
    context.drawImage(qrImage, (width - qrSize) / 2, height - 140, qrSize, qrSize);
    context.fillStyle = '#b9b7aa';
    context.font = '18px system-ui, sans-serif';
    context.fillText('扫码查看详情', width / 2, height - 46);
    imageUrl.value = canvas.toDataURL('image/png');
  } catch {
    error.value = '分享图片暂时无法生成，请复制链接分享。';
  } finally {
    busy.value = false;
  }
}

async function saveImage(): Promise<void> {
  if (!imageUrl.value) return;
  const link = document.createElement('a');
  link.href = imageUrl.value;
  link.download = props.data.kind === 'PROFILE' ? '牌友主页分享.png' : '社区帖子分享.png';
  link.click();
}

async function share(): Promise<void> {
  if (typeof navigator.share !== 'function') { await saveImage(); return; }
  try {
    const response = await fetch(imageUrl.value);
    const file = new File([await response.blob()], props.data.kind === 'PROFILE' ? '牌友主页.png' : '社区帖子.png', { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ title: props.data.title, text: props.data.subtitle, url: props.data.url, files: [file] });
    else await navigator.share({ title: props.data.title, text: props.data.subtitle, url: props.data.url });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') return;
    error.value = '系统分享未完成，可以保存图片或复制链接。';
  }
}

async function copyUrl(): Promise<void> {
  try { await navigator.clipboard.writeText(props.data.url); error.value = '链接已复制。'; }
  catch { error.value = props.data.url; }
}

onMounted(() => { void createPreview(); });
watch(() => props.data, () => { void createPreview(); });
</script>

<template>
  <div class="social-share-backdrop" role="presentation" @click.self="emit('close')">
    <section class="social-share-dialog" role="dialog" aria-modal="true" aria-labelledby="social-share-title">
      <header><div><small>分享给牌友</small><h2 id="social-share-title">{{ data.kind === 'PROFILE' ? '分享个人主页' : '分享这篇帖子' }}</h2></div><button type="button" aria-label="关闭分享" @click="emit('close')">×</button></header>
      <div class="social-share-preview"><img v-if="imageUrl" :src="imageUrl" alt="分享海报预览" /><p v-else-if="busy" role="status">正在生成二维码和分享图片…</p><p v-else>图片预览暂不可用</p></div>
      <p v-if="error" class="social-share-feedback" role="status">{{ error }}</p>
      <footer><button type="button" :disabled="busy || !imageUrl" @click="share">系统分享</button><button type="button" :disabled="busy || !imageUrl" @click="saveImage">保存图片</button><button class="social-share-primary" type="button" @click="copyUrl">复制链接</button></footer>
    </section>
  </div>
</template>

<style scoped>
.social-share-backdrop{position:fixed;z-index:220;inset:0;display:grid;place-items:center;padding:16px;background:#06100edb;backdrop-filter:blur(8px)}.social-share-dialog{box-sizing:border-box;width:min(100%,480px);max-height:min(92svh,900px);overflow:auto;padding:18px;border:1px solid #d9b66c66;border-radius:20px;background:linear-gradient(145deg,#172a25,#0e1916);box-shadow:0 25px 90px #000b;color:#f2ecdc}.social-share-dialog>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}.social-share-dialog header small{color:#e3c579;font-size:11px}.social-share-dialog h2{margin:5px 0 0;font-size:20px}.social-share-dialog header button{width:40px;height:40px;border:1px solid #ffffff25;border-radius:12px;background:#ffffff08;color:#f2ecdc;font-size:24px}.social-share-preview{display:grid;place-items:center;min-height:240px;padding:12px;border-radius:16px;background:#080f0d}.social-share-preview img{display:block;width:min(100%,320px);height:auto;border-radius:10px}.social-share-preview p{color:#c7c1b0;text-align:center}.social-share-feedback{color:#e9cb81;font-size:13px}.social-share-dialog footer{display:flex;gap:8px;margin-top:14px}.social-share-dialog footer button{flex:1;min-width:0;min-height:44px;padding:8px;border:1px solid #d9b66c55;border-radius:11px;background:#ffffff08;color:#efdfbd;font-weight:650}.social-share-dialog footer .social-share-primary{background:#d9b66c;color:#211f19}@media(max-width:380px){.social-share-dialog{padding:14px}.social-share-dialog footer{flex-wrap:wrap}.social-share-dialog footer button{flex-basis:calc(50% - 8px)}}
</style>
