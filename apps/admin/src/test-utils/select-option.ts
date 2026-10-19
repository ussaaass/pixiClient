import { nextTick } from 'vue';

export async function chooseAdminOption(root: ParentNode, selector: string, label: string): Promise<void> {
  const select = root.querySelector<HTMLElement>(selector);
  if (!select) throw new Error(`Admin selector not found: ${selector}`);
  const trigger = select?.querySelector<HTMLElement>('.el-select__wrapper');
  if (!trigger) throw new Error(`Admin selector not found: ${selector}`);
  trigger.click();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const listboxId = select.querySelector<HTMLElement>('[aria-controls]')?.getAttribute('aria-controls');
  const popper = listboxId ? document.getElementById(listboxId)?.closest('.el-select__popper') : null;
  const option = [...(popper ?? document).querySelectorAll<HTMLElement>('.el-select-dropdown__item')]
    .find((item) => item.textContent?.trim() === label);
  if (!option) throw new Error(`Admin option not found: ${label}`);
  option.click();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function adminSelectLabel(root: ParentNode, selector: string): string | undefined {
  return root.querySelector<HTMLElement>(`${selector} .el-select__selection`)?.textContent?.trim();
}
