import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPracticeAccessibilityControls, type PracticeAccessibilityActions, type PracticeAccessibilityState } from '../../../games/shisanshui/client/src/accessibility-controls';

describe('十三张本地练习的语义化控制', () => {
  let controls: ReturnType<typeof createPracticeAccessibilityControls> | undefined;

  afterEach(() => {
    controls?.element.remove();
    controls = undefined;
  });

  it('提供原生键盘控件、状态播报、焦点保持和完整摊牌文本', () => {
    const actions: PracticeAccessibilityActions = {
      selectHandCard: vi.fn(),
      placeSelectedCard: vi.fn(),
      retrievePileCard: vi.fn(),
      arrangeOrReplay: vi.fn(),
      redeal: vi.fn(),
      reveal: vi.fn(),
      exit: vi.fn(),
    };
    controls = createPracticeAccessibilityControls(actions);
    document.body.append(controls.element);

    const initial: PracticeAccessibilityState = {
      phase: 'arranging',
      statusText: '选择一张手牌，再点对应牌墩。',
      hand: [{ id: '0', label: '黑桃2' }, { id: '1', label: '黑桃3' }],
      piles: [
        { name: 'front', label: '头墩', count: 3, rank: '0/3 张', cards: [] },
        { name: 'middle', label: '中墩', count: 5, rank: '0/5 张', cards: [] },
        { name: 'back', label: '底墩', count: 5, rank: '0/5 张', cards: [] },
      ],
      canReveal: false,
      confirmFoul: false,
    };
    controls.update(initial);
    const summary = controls.element.querySelector('summary')!;
    summary.click();
    expect(controls.element.open).toBe(true);

    const handButton = controls.element.querySelector<HTMLButtonElement>('button[data-control-key="hand-1"]')!;
    expect(handButton.tabIndex).toBe(0);
    handButton.focus();
    handButton.click();
    expect(actions.selectHandCard).toHaveBeenCalledWith('1');
    controls.update({ ...initial, selectedCardId: '1', statusText: '已选中黑桃3，请选择目标牌墩。' });
    expect(controls.element.querySelector('[role="status"]')?.textContent).toContain('已选中黑桃3');
    expect(controls.element.querySelector<HTMLButtonElement>('button[data-control-key="hand-1"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(controls.element.querySelector('button[data-control-key="hand-1"]'));

    controls.element.querySelector<HTMLButtonElement>('button[data-control-key="place-front"]')!.focus();
    controls.element.querySelector<HTMLButtonElement>('button[data-control-key="place-front"]')!.click();
    expect(actions.placeSelectedCard).toHaveBeenCalledWith('front');
    controls.update({
      ...initial,
      statusText: '黑桃3已放入头墩。',
      hand: [{ id: '0', label: '黑桃2' }],
      piles: [
        { name: 'front', label: '头墩', count: 3, rank: '1/3 张', cards: [{ id: '1', label: '黑桃3' }] },
        initial.piles[1]!,
        initial.piles[2]!,
      ],
    });
    expect(controls.element.querySelector('[role="status"]')?.textContent).toContain('已放入头墩');
    expect(controls.element.querySelector('button[data-control-key="pile-front-1"]')?.textContent).toBe('取回黑桃3');
    expect(document.activeElement).toBe(controls.element.querySelector('button[data-control-key="pile-front-1"]'));

    controls.update({
      ...initial,
      phase: 'revealed',
      statusText: '牌局已结算。只记录本地演示分数。',
      results: [{ label: '你', summary: '你：+2 水；自己的牌组。', cardsByPile: '头墩：黑桃3；中墩：红桃A；底墩：方块K' }],
    });
    expect(controls.element.textContent).toContain('本局摊牌，虚拟水数，不涉及金币');
    expect(controls.element.textContent).toContain('头墩：黑桃3；中墩：红桃A；底墩：方块K');
    expect(controls.element.querySelector('[role="status"]')?.textContent).toContain('牌局已结算');
    controls.element.querySelector<HTMLButtonElement>('button[data-control-key="action-exit"]')!.click();
    expect(actions.exit).toHaveBeenCalledOnce();
  });
});
