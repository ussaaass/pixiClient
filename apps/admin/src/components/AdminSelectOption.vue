<script lang="ts">
import { ElOption } from 'element-plus/es/components/select/index';
import { defineComponent, h, isVNode, type Component, type VNodeChild } from 'vue';

function vnodeText(node: VNodeChild): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(vnodeText).join('');
  if (!isVNode(node)) return '';
  if (typeof node.children === 'string') return node.children;
  if (Array.isArray(node.children)) return node.children.map(vnodeText).join('');
  if (node.children && typeof node.children === 'object' && 'default' in node.children && typeof node.children.default === 'function') {
    return vnodeText(node.children.default());
  }
  return '';
}

export default defineComponent({
  name: 'AdminSelectOption',
  inheritAttrs: false,
  setup(_props, { attrs, slots }) {
    return () => h(ElOption as Component, { ...attrs, label: vnodeText(slots.default?.() ?? []).trim() }, slots.default?.());
  },
});
</script>
