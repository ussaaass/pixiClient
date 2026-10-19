import type { PileName } from '@gameing/shisanshui-rules';

export interface AccessibleCard {
  readonly id: string;
  readonly label: string;
}

export interface AccessiblePile {
  readonly name: PileName;
  readonly label: string;
  readonly count: number;
  readonly rank: string;
  readonly cards: readonly AccessibleCard[];
}

export interface AccessiblePlayerResult {
  readonly label: string;
  readonly summary: string;
  readonly cardsByPile: string;
}

export interface PracticeAccessibilityState {
  readonly phase: 'arranging' | 'revealed';
  readonly statusText: string;
  readonly autoGameActive: boolean;
  readonly hand: readonly AccessibleCard[];
  readonly selectedCardId?: string;
  readonly piles: readonly AccessiblePile[];
  readonly canReveal: boolean;
  readonly confirmFoul: boolean;
  readonly results?: readonly AccessiblePlayerResult[];
}

export interface PracticeAccessibilityActions {
  readonly selectHandCard: (cardId: string) => void;
  readonly placeSelectedCard: (pile: PileName) => void;
  readonly retrievePileCard: (pile: PileName, cardId: string) => void;
  readonly arrangeOrReplay: () => void;
  readonly startAutoGame: (rounds: number | 'INFINITE') => void;
  readonly stopAutoGame: () => void;
  readonly redeal: () => void;
  readonly reveal: () => void;
  readonly exit: () => void;
}

export interface PracticeAccessibilityControls {
  readonly element: HTMLDetailsElement;
  update(state: PracticeAccessibilityState): void;
}

export function createPracticeAccessibilityControls(actions: PracticeAccessibilityActions): PracticeAccessibilityControls {
  const element = document.createElement('details');
  element.className = 'practice-accessibility';
  const summary = document.createElement('summary');
  summary.textContent = '键盘与读屏操作';
  summary.setAttribute('aria-label', '键盘与读屏操作');
  const panel = document.createElement('div');
  panel.className = 'practice-accessibility-panel';
  const instructions = document.createElement('p');
  instructions.textContent = '先从手牌选择一张，再选择目标牌墩；已放入的牌可取回。按钮顺序可用 Tab 键浏览，Enter 或空格键操作。';
  const status = document.createElement('p');
  status.className = 'practice-accessibility-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('aria-atomic', 'true');

  const makeButton = (
    label: string,
    key: string,
    action: () => void,
    disabled = false,
    pressed?: boolean,
  ): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = disabled;
    button.dataset.controlKey = key;
    if (pressed !== undefined) button.setAttribute('aria-pressed', String(pressed));
    button.addEventListener('click', action);
    return button;
  };

  const group = (title: string, headingLevel: 'h2' | 'h3' = 'h2'): [HTMLElement, HTMLElement] => {
    const section = document.createElement('section');
    section.className = 'practice-accessibility-group';
    const heading = document.createElement(headingLevel);
    heading.textContent = title;
    section.append(heading);
    return [section, heading];
  };

  const actionsGroup = (): HTMLElement => {
    const section = document.createElement('section');
    section.className = 'practice-accessibility-group practice-accessibility-actions';
    return section;
  };

  panel.append(instructions, status);
  element.append(summary, panel);

  return {
    element,
    update(state): void {
      const active = document.activeElement;
      const restoreFocus = active instanceof HTMLElement && panel.contains(active);
      const activeKey = restoreFocus && active instanceof HTMLElement ? active.dataset.controlKey : undefined;
      const content: HTMLElement[] = [];
      status.textContent = state.statusText;

      if (state.phase === 'arranging') {
        const [handGroup, handHeading] = group(`手牌，${state.hand.length} 张`);
        if (state.hand.length === 0) {
          const empty = document.createElement('p');
          empty.textContent = '手牌已摆完。';
          handGroup.append(empty);
        } else {
          const handList = document.createElement('div');
          handList.className = 'practice-accessibility-buttons';
          state.hand.forEach((card) => {
            const selected = state.selectedCardId === card.id;
            handList.append(makeButton(
              `${card.label}${selected ? '，已选中' : ''}`,
              `hand-${card.id}`,
              () => actions.selectHandCard(card.id),
              false,
              selected,
            ));
          });
          handGroup.append(handList);
        }
        handHeading.id = 'practice-accessibility-hand-heading';
        content.push(handGroup);

        const [pilesGroup] = group('三道牌组');
        state.piles.forEach((pile) => {
          const [pileSection] = group(`${pile.label}，${pile.rank}`, 'h3');
          const cardList = document.createElement('div');
          cardList.className = 'practice-accessibility-buttons';
          pile.cards.forEach((card) => {
            cardList.append(makeButton(`取回${card.label}`, `pile-${pile.name}-${card.id}`, () => {
              actions.retrievePileCard(pile.name, card.id);
            }));
          });
          const placeButton = makeButton(
            `将已选牌放入${pile.label}（${pile.cards.length}/${pile.count}）`,
            `place-${pile.name}`,
            () => actions.placeSelectedCard(pile.name),
            state.selectedCardId === undefined || pile.cards.length >= pile.count,
          );
          pileSection.append(cardList, placeButton);
          pilesGroup.append(pileSection);
        });
        content.push(pilesGroup);

        const actionsSection = actionsGroup();
        if (state.autoGameActive) {
          actionsSection.append(makeButton('停止自动游戏', 'action-auto-stop', actions.stopAutoGame));
        } else {
          actionsSection.append(
            makeButton('自动游戏 10 局', 'action-auto-10', () => actions.startAutoGame(10)),
            makeButton('自动游戏 50 局', 'action-auto-50', () => actions.startAutoGame(50)),
            makeButton('自动游戏 100 局', 'action-auto-100', () => actions.startAutoGame(100)),
            makeButton('自动游戏无限局', 'action-auto-infinite', () => actions.startAutoGame('INFINITE')),
          );
        }
        actionsSection.append(
          makeButton('自动摆牌', 'action-arrange', actions.arrangeOrReplay),
          makeButton('重新发牌', 'action-redeal', actions.redeal),
          makeButton(state.confirmFoul ? '确认相公开牌' : '开牌比一比', 'action-reveal', actions.reveal, !state.canReveal),
        );
        content.push(actionsSection);
      } else if (state.results) {
        const [resultsGroup] = group('本局摊牌，虚拟水数，不涉及金币');
        state.results.forEach((result) => {
          const summary = document.createElement('p');
          summary.textContent = result.summary;
          const cards = document.createElement('p');
          cards.textContent = result.cardsByPile;
          resultsGroup.append(summary, cards);
        });
        content.push(resultsGroup);
        const actionsSection = actionsGroup();
        actionsSection.append(state.autoGameActive
          ? makeButton('停止自动游戏', 'action-auto-stop', actions.stopAutoGame)
          : makeButton('再来一局', 'action-arrange', actions.arrangeOrReplay));
        content.push(actionsSection);
      }

      const exitSection = actionsGroup();
      exitSection.append(makeButton('退出练习', 'action-exit', actions.exit));
      content.push(exitSection);
      panel.replaceChildren(instructions, status, ...content);

      if (activeKey) {
        let replacement = Array.from(panel.querySelectorAll<HTMLButtonElement>('button[data-control-key]'))
          .find((button) => button.dataset.controlKey === activeKey && !button.disabled);
        if (!replacement && activeKey.startsWith('place-')) {
          const pileName = activeKey.slice('place-'.length);
          replacement = Array.from(panel.querySelectorAll<HTMLButtonElement>(`button[data-control-key^="pile-${pileName}-"]`)).at(-1);
        }
        if (!replacement && activeKey.startsWith('pile-')) {
          const [, , cardId] = activeKey.split('-');
          replacement = panel.querySelector<HTMLButtonElement>(`button[data-control-key="hand-${cardId}"]`) ?? undefined;
        }
        (replacement ?? summary).focus({ preventScroll: true });
      }
    },
  };
}
