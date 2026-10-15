import { Application, Container, Graphics, Text } from 'pixi.js';
import { createPracticeAccessibilityControls } from './accessibility-controls';
import { createPracticeAudio, PracticeSoundEvent } from './practice-audio';
import {
  autoArrange,
  CLASSIC_V1_SCORING,
  evaluateFive,
  evaluateFront,
  HAND_CATEGORY,
  settleRound,
  validateArrangement,
  type Arrangement,
  type CardId,
  type PlayerArrangement,
  type PileName,
} from '@gameing/shisanshui-rules';

export interface LocalGameOptions {
  readonly onExit: () => void;
  readonly tierName: string;
  readonly roomCode?: string;
  readonly opponentNames?: readonly string[];
  readonly soundEnabled?: boolean;
}

export interface LocalGameSession {
  dispose(): Promise<void>;
}

type GamePhase = 'arranging' | 'revealed';

const PILES: readonly { readonly name: PileName; readonly label: string; readonly count: number }[] = [
  { name: 'front', label: '头墩 · 3张', count: 3 },
  { name: 'middle', label: '中墩 · 5张', count: 5 },
  { name: 'back', label: '底墩 · 5张', count: 5 },
];

const CATEGORY_LABEL: Readonly<Record<number, string>> = {
  [HAND_CATEGORY.HIGH_CARD]: '乌龙',
  [HAND_CATEGORY.PAIR]: '对子',
  [HAND_CATEGORY.TWO_PAIR]: '两对',
  [HAND_CATEGORY.THREE_OF_A_KIND]: '三条',
  [HAND_CATEGORY.STRAIGHT]: '顺子',
  [HAND_CATEGORY.FLUSH]: '同花',
  [HAND_CATEGORY.FULL_HOUSE]: '葫芦',
  [HAND_CATEGORY.FOUR_OF_A_KIND]: '铁支',
  [HAND_CATEGORY.STRAIGHT_FLUSH]: '同花顺',
};

const SUITS = ['♠', '♥', '♣', '♦'] as const;

function shuffledDeck(): CardId[] {
  const cards = Array.from({ length: 52 }, (_, index) => index);
  const random = new Uint32Array(1);
  for (let index = cards.length - 1; index > 0; index -= 1) {
    crypto.getRandomValues(random);
    const other = random[0]! % (index + 1);
    [cards[index], cards[other]] = [cards[other]!, cards[index]!];
  }
  return cards;
}

function cardLabel(card: CardId): { readonly rank: string; readonly suit: string; readonly red: boolean } {
  const rankNumber = (card % 13) + 2;
  return {
    rank: ({ 14: 'A', 13: 'K', 12: 'Q', 11: 'J' } as Record<number, string>)[rankNumber] ?? String(rankNumber),
    suit: SUITS[Math.floor(card / 13)]!,
    red: Math.floor(card / 13) === 1 || Math.floor(card / 13) === 3,
  };
}

export async function mountLocalGame(target: HTMLElement, options: LocalGameOptions): Promise<LocalGameSession> {
  const app = new Application();
  await app.init({
    resizeTo: target,
    background: '#0b4037',
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  });
  target.replaceChildren(app.canvas);
  app.canvas.setAttribute('aria-label', '十三张本地练习牌桌');
  app.canvas.style.display = 'block';
  app.canvas.style.width = '100%';
  app.canvas.style.height = '100%';

  const scene = new Container();
  app.stage.addChild(scene);
  let phase: GamePhase = 'arranging';
  let hand: CardId[] = [];
  let piles: Record<PileName, CardId[]> = { front: [], middle: [], back: [] };
  let selected: CardId | undefined;
  let players: readonly PlayerArrangement[] = [];
  let result: ReturnType<typeof settleRound> | undefined;
  let statusText = '选择一张手牌，再点对应牌墩；已放入的牌可点回手牌。';
  let foulConfirmationArmed = false;
  let disposed = false;
  const audio = createPracticeAudio(options.soundEnabled ?? true);

  const opponentLabel = (playerId: string): string => {
    const index = Number(playerId.slice(-1)) - 1;
    return options.opponentNames?.[index]?.slice(0, 8) ?? `演示对手${index + 1}`;
  };

  const clearScene = (): void => {
    for (const child of scene.removeChildren()) child.destroy({ children: true });
  };

  const beginRound = (): void => {
    const deck = shuffledDeck();
    const allHands = Array.from({ length: 4 }, (_, playerIndex) => deck.slice(playerIndex * 13, (playerIndex + 1) * 13));
    hand = allHands[0]!;
    piles = { front: [], middle: [], back: [] };
    selected = undefined;
    result = undefined;
    phase = 'arranging';
    foulConfirmationArmed = false;
    statusText = '选择一张手牌，再点对应牌墩；已放入的牌可点回手牌。';
    players = [{ playerId: 'you', heldCards: hand, arrangement: { front: [], middle: [], back: [] } }];
    for (let index = 1; index < allHands.length; index += 1) {
      const botHand = allHands[index]!;
      const suggestion = autoArrange(botHand);
      if (!suggestion.valid) throw new Error('无法为演示对手生成合法牌型');
      players = [...players, { playerId: `demo-${index}`, heldCards: botHand, arrangement: suggestion.arrangement }];
    }
  };

  const text = (value: string, x: number, y: number, size: number, color = '#f7f0dc', weight: '500' | '700' = '500'): Text => {
    const item = new Text({
      text: value,
      style: { fontFamily: 'system-ui, -apple-system, sans-serif', fontSize: size, fill: color, fontWeight: weight },
    });
    item.position.set(x, y);
    return item;
  };

  const roundedPanel = (x: number, y: number, width: number, height: number, color = 0x0b302b): Graphics =>
    new Graphics().roundRect(x, y, width, height, 14).fill({ color, alpha: 0.86 }).stroke({ color: 0xd6b76f, alpha: 0.42, width: 1 });

  const pileResultAgainstUser = (playerId: string, pileName: PileName): -1 | 0 | 1 => {
    const pair = result?.pairs.find((entry) =>
      (entry.leftPlayerId === 'you' && entry.rightPlayerId === playerId)
      || (entry.rightPlayerId === 'you' && entry.leftPlayerId === playerId),
    );
    const pile = pair?.piles.find((entry) => entry.pile === pileName);
    if (!pair || !pile) return 0;
    return pair.leftPlayerId === 'you' ? pile.result : -pile.result as -1 | 0 | 1;
  };

  const pileResultLabel = (playerId: string, pileName: PileName): string => {
    const resultAgainstUser = pileResultAgainstUser(playerId, pileName);
    return resultAgainstUser > 0 ? '胜' : resultAgainstUser < 0 ? '负' : '平';
  };

  const addButton = (label: string, x: number, y: number, width: number, onTap: () => void, disabled = false): void => {
    const button = new Container();
    button.eventMode = disabled ? 'none' : 'static';
    button.cursor = disabled ? 'default' : 'pointer';
    button.addChild(new Graphics().roundRect(x, y, width, 42, 11)
      .fill({ color: disabled ? 0x36524a : 0xb68b43, alpha: 0.96 })
      .stroke({ color: 0xf2d58b, alpha: 0.55, width: 1 }));
    const caption = text(label, 0, 0, 14, disabled ? '#a8b5ab' : '#14241d', '700');
    caption.anchor.set(0.5);
    caption.position.set(x + width / 2, y + 21);
    button.addChild(caption);
    button.on('pointertap', onTap);
    scene.addChild(button);
  };

  const addCard = (card: CardId, x: number, y: number, width: number, height: number, isSelected: boolean, onTap: () => void): void => {
    const face = cardLabel(card);
    const container = new Container();
    container.position.set(x, y - (isSelected ? 9 : 0));
    container.eventMode = 'static';
    container.cursor = 'pointer';
    container.addChild(new Graphics().roundRect(0, 0, width, height, 6)
      .fill(0xfffcf3)
      .stroke({ color: isSelected ? 0xf5c75a : 0xaaa493, width: isSelected ? 3 : 1 }));
    container.addChild(text(face.rank, 4, 3, Math.max(12, width * 0.3), face.red ? '#bf3f3c' : '#18231f', '700'));
    container.addChild(text(face.suit, 4, Math.max(19, height * 0.37), Math.max(12, width * 0.3), face.red ? '#bf3f3c' : '#18231f', '700'));
    container.on('pointertap', (event) => {
      event.stopPropagation();
      onTap();
    });
    scene.addChild(container);
  };

  const currentArrangement = (): Arrangement => ({ front: piles.front, middle: piles.middle, back: piles.back });
  const handRankLine = (name: PileName, cards: readonly CardId[]): string => {
    if (cards.length !== (name === 'front' ? 3 : 5)) return `${cards.length}/${name === 'front' ? 3 : 5} 张`;
    const rank = name === 'front' ? evaluateFront(cards) : evaluateFive(cards);
    return `${CATEGORY_LABEL[rank.category]}${rank.tieBreak[0] ? ` · ${rank.tieBreak[0]}` : ''}`;
  };

  const cardAccessibleName = (card: CardId): string => {
    const face = cardLabel(card);
    const suitName: Readonly<Record<string, string>> = { '♠': '黑桃', '♥': '红桃', '♣': '梅花', '♦': '方块' };
    return `${suitName[face.suit] ?? face.suit}${face.rank}`;
  };

  function performAutoArrangeOrReplay(): void {
    if (phase === 'revealed') {
      beginRound();
      audio.play(PracticeSoundEvent.REDEAL);
    } else {
      const suggestion = autoArrange(players[0]!.heldCards);
      if (!suggestion.valid) {
        statusText = '这手牌暂时没有找到合法摆法，请重新发牌。';
        audio.play(PracticeSoundEvent.INVALID_ACTION);
      } else {
        piles = {
          front: [...suggestion.arrangement.front],
          middle: [...suggestion.arrangement.middle],
          back: [...suggestion.arrangement.back],
        };
        hand = [];
        selected = undefined;
        foulConfirmationArmed = false;
        statusText = '自动摆牌仅供练习参考；你仍可点牌取回并调整。';
        audio.play(PracticeSoundEvent.AUTO_ARRANGE);
      }
    }
    render();
  }

  function redeal(): void {
    beginRound();
    audio.play(PracticeSoundEvent.REDEAL);
    render();
  }

  function revealRound(): void {
    if (phase === 'revealed') return;
    const arrangement = currentArrangement();
    const validation = validateArrangement(players[0]!.heldCards, arrangement);
    if (!validation.valid) {
      statusText = `还不能开牌：${validation.reason === 'INVALID_PILE_COUNTS' ? '请摆满头墩3张、中墩5张、底墩5张。' : '请检查手牌是否完整。'}`;
      audio.play(PracticeSoundEvent.INVALID_ACTION);
      render();
      return;
    }
    if (validation.value.foul && !foulConfirmationArmed) {
      foulConfirmationArmed = true;
      statusText = '倒道（相公）将判负；再点“确认相公开牌”继续。';
      render();
      return;
    }
    foulConfirmationArmed = false;
    players = players.map((player, index) => index === 0 ? {
      ...player,
      arrangement: { front: [...arrangement.front], middle: [...arrangement.middle], back: [...arrangement.back] },
    } : player);
    result = settleRound(players, CLASSIC_V1_SCORING);
    phase = 'revealed';
    const score = result.players.find((player) => player.playerId === 'you')?.water ?? 0;
    audio.play(score > 0 ? PracticeSoundEvent.ROUND_WIN : score < 0 ? PracticeSoundEvent.ROUND_LOSS : PracticeSoundEvent.ROUND_TIE);
    statusText = validation.value.foul ? '倒道（相公）：本局按练习规则判负。' : '牌局已结算。分数只用于本地演示，不记录到服务器。';
    render();
  }

  const accessibleControls = createPracticeAccessibilityControls({
    selectHandCard(cardId) {
      const card = Number(cardId) as CardId;
      selected = selected === card ? undefined : card;
      audio.play(PracticeSoundEvent.CARD_SELECT);
      const label = cardAccessibleName(card);
      statusText = selected === undefined ? '已取消选择。' : `已选中${label}，请选择目标牌墩。`;
      render();
    },
    placeSelectedCard(name) {
      const pile = PILES.find((entry) => entry.name === name)!;
      if (selected === undefined || piles[name].length >= pile.count || phase !== 'arranging') return;
      const label = cardAccessibleName(selected);
      piles[name] = [...piles[name], selected];
      hand = hand.filter((card) => card !== selected);
      selected = undefined;
      foulConfirmationArmed = false;
      statusText = `${label}已放入${pile.label.split(' · ')[0]}。`;
      audio.play(PracticeSoundEvent.CARD_PLACE);
      render();
    },
    retrievePileCard(name, cardId) {
      const card = Number(cardId) as CardId;
      const label = cardAccessibleName(card);
      piles[name] = piles[name].filter((value) => value !== card);
      hand = [...hand, card];
      selected = card;
      audio.play(PracticeSoundEvent.CARD_RETURN);
      foulConfirmationArmed = false;
      statusText = `已取回${label}。请选择目标牌墩放回。`;
      render();
    },
    arrangeOrReplay: performAutoArrangeOrReplay,
    redeal,
    reveal: revealRound,
    exit: options.onExit,
  });
  target.append(accessibleControls.element);

  const renderAccessibleControls = (): void => {
    const cards = (values: readonly CardId[]) => values.map((card) => ({ id: String(card), label: cardAccessibleName(card) }));
    const compact = app.screen.width < 650 || (app.screen.width >= 650 && app.screen.height < 560);
    const side = compact ? 12 : Math.max(24, app.screen.width * 0.045);
    accessibleControls.element.style.setProperty('--practice-accessibility-right', `${side + 86}px`);
    accessibleControls.update({
      phase,
      statusText,
      hand: cards(hand),
      ...(selected === undefined ? {} : { selectedCardId: String(selected) }),
      piles: PILES.map(({ name, label, count }) => ({
        name,
        label: label.split(' · ')[0]!,
        count,
        rank: handRankLine(name, piles[name]),
        cards: cards(piles[name]),
      })),
      canReveal: hand.length === 0 && piles.front.length === 3 && piles.middle.length === 5 && piles.back.length === 5,
      confirmFoul: foulConfirmationArmed,
      ...(phase === 'revealed' && result ? { results: players.map((player) => {
        const playerResult = result!.players.find((entry) => entry.playerId === player.playerId);
        const label = player.playerId === 'you' ? '你' : opponentLabel(player.playerId);
        const score = playerResult?.water ?? 0;
        const outcome = player.playerId === 'you'
          ? '自己的牌组'
          : PILES.map(({ name, label: pileLabel }) => `${pileLabel.split(' · ')[0]}${pileResultLabel(player.playerId, name)}`).join('、');
        return {
          label,
          summary: `${label}：${score > 0 ? '+' : ''}${score} 水；${outcome}${playerResult?.foul ? '；相公' : ''}。`,
          cardsByPile: PILES.map(({ name, label: pileLabel }) => `${pileLabel.split(' · ')[0]}：${player.arrangement[name].map(cardAccessibleName).join('、')}`).join('；'),
        };
      }) } : {}),
    });
  };

  const render = (): void => {
    if (disposed) return;
    clearScene();
    const width = app.screen.width;
    const height = app.screen.height;
    const shortWide = width >= 650 && height < 560;
    const compact = width < 650 || shortWide;
    const side = compact ? 12 : Math.max(24, width * 0.045);
    const cardWidth = Math.min(shortWide ? 28 : compact ? 49 : 70, Math.max(33, (width - side * 2) / 8));
    const cardHeight = cardWidth * 1.38;

    scene.addChild(new Graphics().rect(0, 0, width, height).fill(0x0b4037));
    scene.addChild(new Graphics().rect(0, 0, width, height).fill({ color: 0x041d19, alpha: 0.2 }));
    scene.addChild(text(`十三张 · ${options.tierName}${options.roomCode ? ` · 房间 ${options.roomCode}` : ''}`, side, 13, compact ? 16 : 21, '#f4d58c', '700'));
    scene.addChild(text('演示对手 · 虚拟牌局 · 不涉及金币或真实结算', side, 39, compact ? 10 : 12, '#c2d2c7'));
    const exitButton = new Container();
    exitButton.eventMode = 'static';
    exitButton.cursor = 'pointer';
    exitButton.addChild(new Graphics().roundRect(width - side - 78, 13, 78, 34, 9).fill({ color: 0xffffff, alpha: 0.1 }).stroke({ color: 0xffffff, alpha: 0.18, width: 1 }));
    const exitLabel = text('退出练习', 0, 0, 12);
    exitLabel.anchor.set(0.5);
    exitLabel.position.set(width - side - 39, 30);
    exitButton.addChild(exitLabel);
    exitButton.on('pointertap', options.onExit);
    scene.addChild(exitButton);

    if (phase === 'arranging') {
      const opponents = players.filter((player) => player.playerId !== 'you');
      const badgeGap = 5;
      const badgeY = shortWide ? 53 : compact ? 59 : 66;
      const badgeWidth = (width - side * 2 - badgeGap * 2) / 3;
      opponents.forEach((_, index) => {
        const x = side + index * (badgeWidth + badgeGap);
        scene.addChild(new Graphics().roundRect(x, badgeY, badgeWidth, 24, 8)
          .fill({ color: 0x082a25, alpha: 0.9 })
          .stroke({ color: 0xd6b76f, alpha: 0.24, width: 1 }));
        scene.addChild(text(`${options.opponentNames?.[index]?.slice(0, 8) ?? `对手${index + 1}`} · 已摆好`, x + 6, badgeY + 6, compact ? 9 : 11, '#dfd1ad'));
      });
    }

    if (phase === 'revealed' && result) {
      scene.addChild(text('本局摊牌 · 虚拟水数，不涉及金币', side, 63, compact ? 11 : 14, '#f4d58c', '700'));
      const cardGap = 1;
      const pileGap = compact ? 4 : 10;
      const cardW = Math.min(compact ? 27 : 34, (width - side * 2 - 12 - cardGap * 10 - pileGap * 2) / 13);
      const cardH = cardW * 1.38;
      const cardsWidth = cardW * 13 + cardGap * 10 + pileGap * 2;
      const cardsX = Math.max(side + 3, (width - cardsWidth) / 2);
      const rowStart = 96;
      const rowHeight = Math.min(64, Math.max(58, (height - 170) / 4));
      const cardYInset = 17;
      const pilesInOrder: readonly PileName[] = ['front', 'middle', 'back'];
      const pileGroupWidths = [3, 5, 5].map((count) => cardW * count + cardGap * (count - 1));
      let headerX = cardsX;
      pilesInOrder.forEach((pileName, index) => {
        const groupWidth = pileGroupWidths[index]!;
        const label = pileName === 'front' ? '头墩' : pileName === 'middle' ? '中墩' : '底墩';
        scene.addChild(text(label, headerX, 80, compact ? 9 : 11, '#f4d58c', '700'));
        headerX += groupWidth + pileGap;
      });

      players.forEach((player, playerIndex) => {
        const y = rowStart + playerIndex * rowHeight;
        const score = result!.players.find((entry) => entry.playerId === player.playerId)?.water ?? 0;
        const label = player.playerId === 'you' ? '你' : opponentLabel(player.playerId);
        const scoreColor = score > 0 ? '#9ce1ad' : score < 0 ? '#f2a095' : '#d9e1d7';
        scene.addChild(roundedPanel(side, y, width - side * 2, rowHeight - 3, 0x082a25));
        const outcome = player.playerId === 'you'
          ? '你的牌组'
          : `对你：头${pileResultLabel(player.playerId, 'front')} · 中${pileResultLabel(player.playerId, 'middle')} · 底${pileResultLabel(player.playerId, 'back')}`;
        const isFoul = result!.players.find((entry) => entry.playerId === player.playerId)?.foul === true;
        scene.addChild(text(`${label}　${score > 0 ? '+' : ''}${score} 水　${outcome}${isFoul ? ' · 相公' : ''}`, side + 7, y + 3, compact ? 9 : 11, scoreColor, '700'));

        let cardX = cardsX;
        pilesInOrder.forEach((pileName, pileIndex) => {
          const pileCards = player.arrangement[pileName];
          pileCards.forEach((card) => {
            addCard(card, cardX, y + cardYInset, cardW, cardH, false, () => undefined);
            cardX += cardW + cardGap;
          });
          if (pileIndex < pilesInOrder.length - 1) {
            cardX += pileGap - cardGap;
            scene.addChild(new Graphics().rect(cardX - pileGap / 2, y + cardYInset, 1, cardH).fill({ color: 0xd6b76f, alpha: 0.5 }));
          }
        });
      });

      const replayWidth = Math.min(180, width - side * 2);
      addButton('再来一局', (width - replayWidth) / 2, height - 51, replayWidth, () => {
        performAutoArrangeOrReplay();
      });
      renderAccessibleControls();
      return;
    }

    const boardTop = shortWide ? 82 : compact ? 102 : Math.max(116, height * 0.17);
    const maxHandCardW = Math.min(cardWidth, (width - side * 2) / 13);
    const handCardH = maxHandCardW * 1.38;
    const handBottomMargin = shortWide ? 100 : compact ? Math.min(220, Math.max(120, height * 0.26)) : 92;
    const handY = height - handCardH - handBottomMargin;
    const availableRowGap = (handY - boardTop - cardHeight - 12) / 3;
    const rowGap = shortWide ? 62 : Math.min(125, Math.max(76, availableRowGap));
    const rowWidth = width - side * 2;
    const gap = Math.max(1, Math.min(7, (rowWidth - cardWidth * 5) / 4));

    PILES.forEach(({ name, label, count }, rowIndex) => {
      const y = boardTop + rowIndex * rowGap;
      scene.addChild(roundedPanel(side, y, rowWidth, cardHeight + (shortWide ? 22 : 29)));
      scene.addChild(text(label, side + 10, y + 8, compact ? 11 : 13, '#f1d794', '700'));
      scene.addChild(text(handRankLine(name, piles[name]), width - side - 94, y + 9, compact ? 10 : 12, '#dce7dc'));
      const row = piles[name];
      const slotCount = count;
      const cardsStart = side + 10;
      const cardsY = y + 27;
      const slots = new Container();
      slots.eventMode = 'static';
      slots.cursor = selected !== undefined && hand.length > 0 && row.length < slotCount ? 'pointer' : 'default';
      slots.addChild(new Graphics().roundRect(cardsStart, cardsY, rowWidth - 20, cardHeight, 6).fill({ color: 0xffffff, alpha: 0.035 }));
      slots.on('pointertap', () => {
        if (selected === undefined || row.length >= slotCount || phase !== 'arranging') return;
        piles[name] = [...row, selected];
        hand = hand.filter((card) => card !== selected);
        selected = undefined;
        foulConfirmationArmed = false;
        statusText = '牌已放入。你也可以点已放入的牌，将它取回手牌。';
        audio.play(PracticeSoundEvent.CARD_PLACE);
        render();
      });
      scene.addChild(slots);
      row.forEach((card, index) => {
        const x = cardsStart + index * (cardWidth + gap);
        addCard(card, x, cardsY, cardWidth, cardHeight, false, () => {
          if (phase !== 'arranging') return;
          piles[name] = piles[name].filter((value) => value !== card);
          hand = [...hand, card];
          selected = card;
          foulConfirmationArmed = false;
          statusText = '已取回手牌。选择目标牌墩放回。';
          audio.play(PracticeSoundEvent.CARD_RETURN);
          render();
        });
      });
    });

    scene.addChild(text(`手牌 ${hand.length} 张`, side, handY - 19, 12, '#d9e6da', '700'));
    const handSpacing = hand.length > 1 ? Math.min(maxHandCardW + 2, (width - side * 2 - maxHandCardW) / (hand.length - 1)) : maxHandCardW;
    const handStart = shortWide ? (width - (maxHandCardW + (hand.length - 1) * handSpacing)) / 2 : side;
    hand.forEach((card, index) => {
      addCard(card, handStart + index * handSpacing, handY, maxHandCardW, handCardH, selected === card, () => {
        selected = selected === card ? undefined : card;
        audio.play(PracticeSoundEvent.CARD_SELECT);
        statusText = selected === undefined ? '已取消选择。' : '已选中手牌，点击上方目标牌墩放置。';
        render();
      });
    });

    const buttonY = height - 57;
    const buttonGap = 8;
    const buttonWidth = Math.min(148, (width - side * 2 - buttonGap * 2) / 3);
    const actionsWidth = buttonWidth * 3 + buttonGap * 2;
    const actionStart = (width - actionsWidth) / 2;
    addButton(phase === 'revealed' ? '再来一局' : '自动摆牌', actionStart, buttonY, buttonWidth, performAutoArrangeOrReplay, false);
    addButton('重新发牌', actionStart + buttonWidth + buttonGap, buttonY, buttonWidth, redeal, phase === 'revealed');
    const ready = hand.length === 0 && piles.front.length === 3 && piles.middle.length === 5 && piles.back.length === 5;
    addButton(phase === 'revealed' ? '已完成' : foulConfirmationArmed ? '确认相公开牌' : '开牌比一比', actionStart + (buttonWidth + buttonGap) * 2, buttonY, buttonWidth, revealRound, !ready || phase === 'revealed');

    const feedback = phase === 'revealed'
      ? result?.players.map((player) => `${player.playerId === 'you' ? '你' : opponentLabel(player.playerId)}: ${player.water > 0 ? '+' : ''}${player.water} 水${player.foul ? '（相公）' : ''}`).join('　') ?? statusText
      : statusText;
    scene.addChild(text(feedback, side, height - 82, compact ? 10 : 12, '#e9e1c9'));
    if (selected !== undefined && phase === 'arranging') {
      scene.addChild(text(`已选：${cardLabel(selected).rank}${cardLabel(selected).suit}`, width - side - 92, handY - 19, 11, '#f4d58c', '700'));
    }
    renderAccessibleControls();
  };

  beginRound();
  render();
  const resize = (): void => render();
  app.renderer.on('resize', resize);

  return {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      app.renderer.off('resize', resize);
      app.destroy({ removeView: true }, { children: true });
      await audio.dispose();
      target.replaceChildren();
    },
  };
}
