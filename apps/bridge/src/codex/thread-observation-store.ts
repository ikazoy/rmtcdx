import type { CodexBridgeEvent, CodexThread, CodexThreadItem } from "./types";

type ObservedItemState = {
  order: number;
  startedItem: CodexThreadItem | null;
  completedItem: CodexThreadItem | null;
  agentText: string;
  planText: string;
  reasoningSummary: string[];
  reasoningContent: string[];
  commandOutput: string;
};

type ObservedTurnState = {
  nextOrder: number;
  itemsById: Map<string, ObservedItemState>;
};

export class CodexThreadObservationStore {
  private readonly turnsBySession = new Map<string, Map<string, ObservedTurnState>>();

  observe(event: CodexBridgeEvent) {
    if (event.type === "item.started") {
      this.observeStartedItem(event.sessionId, event.turnId, event.item);
      return;
    }

    if (event.type === "item.completed") {
      this.observeCompletedItem(event.sessionId, event.turnId, event.item);
      return;
    }

    if (event.type !== "item.delta") {
      return;
    }

    const item = this.observeItem(event.sessionId, event.turnId, event.itemId);
    switch (event.kind) {
      case "agentMessage.text":
        item.agentText += event.delta;
        return;
      case "plan.text":
        item.planText += event.delta;
        return;
      case "reasoning.summaryText":
        item.reasoningSummary = updateIndexedText(item.reasoningSummary, event.summaryIndex, event.delta);
        return;
      case "reasoning.text":
        item.reasoningContent = updateIndexedText(item.reasoningContent, event.contentIndex, event.delta);
        return;
      case "commandExecution.output":
        item.commandOutput += event.delta;
        return;
      case "fileChange.output":
        return;
    }
  }

  materializeThread(thread: CodexThread) {
    const turnsForSession = this.turnsBySession.get(thread.id);
    if (!turnsForSession || thread.turns.length === 0) {
      return thread;
    }

    let changed = false;
    const turns = thread.turns.map((turn) => {
      const observedTurn = turnsForSession.get(turn.id);
      if (!observedTurn || observedTurn.itemsById.size === 0 || turn.items.length === 0) {
        return turn;
      }

      const nextTurn = this.materializeTurn(turn, observedTurn);
      if (nextTurn !== turn) {
        changed = true;
      }
      return nextTurn;
    });

    return changed ? { ...thread, turns } : thread;
  }

  private materializeTurn(turn: CodexThread["turns"][number], observedTurn: ObservedTurnState) {
    const observedItems = turn.items
      .map((item) => ({ item, observed: observedTurn.itemsById.get(item.id) ?? null }))
      .filter((entry): entry is { item: CodexThreadItem; observed: ObservedItemState } => Boolean(entry.observed));

    if (observedItems.length === 0) {
      return turn;
    }

    const sortedObserved = [...observedItems]
      .sort((left, right) => left.observed.order - right.observed.order)
      .map((entry) => this.overlayObservedItem(entry.item, entry.observed));

    let observedIndex = 0;
    let changed = false;
    const nextItems = turn.items.map((item) => {
      const observed = observedTurn.itemsById.get(item.id);
      if (!observed) {
        return item;
      }

      const nextItem = sortedObserved[observedIndex++] ?? item;
      if (nextItem !== item || nextItem.id !== item.id) {
        changed = true;
      }
      return nextItem;
    });

    return changed ? { ...turn, items: nextItems } : turn;
  }

  private overlayObservedItem(item: CodexThreadItem, observed: ObservedItemState) {
    const completedItem = observed.completedItem;
    const baseItem = completedItem?.type === item.type ? completedItem : item;

    if (baseItem.type === "agentMessage" && "text" in baseItem) {
      const nextText = observed.agentText || baseItem.text;
      if (nextText === baseItem.text) {
        return baseItem;
      }
      return {
        ...baseItem,
        text: nextText
      } satisfies CodexThreadItem;
    }

    if (baseItem.type === "plan" && "text" in baseItem) {
      const nextText = observed.planText || baseItem.text;
      if (nextText === baseItem.text) {
        return baseItem;
      }
      return {
        ...baseItem,
        text: nextText
      } satisfies CodexThreadItem;
    }

    if (baseItem.type === "reasoning" && "summary" in baseItem && "content" in baseItem) {
      const nextSummary = observed.reasoningSummary.length > 0 ? observed.reasoningSummary : baseItem.summary;
      const nextContent = observed.reasoningContent.length > 0 ? observed.reasoningContent : baseItem.content;
      if (sameStringArray(baseItem.summary, nextSummary) && sameStringArray(baseItem.content, nextContent)) {
        return baseItem;
      }
      return {
        ...baseItem,
        summary: nextSummary,
        content: nextContent
      } satisfies CodexThreadItem;
    }

    if (baseItem.type === "commandExecution" && "aggregatedOutput" in baseItem) {
      const nextOutput = observed.commandOutput || baseItem.aggregatedOutput;
      if (nextOutput === baseItem.aggregatedOutput) {
        return baseItem;
      }
      return {
        ...baseItem,
        aggregatedOutput: nextOutput
      } satisfies CodexThreadItem;
    }

    return baseItem;
  }

  private observeStartedItem(sessionId: string, turnId: string, item: CodexThreadItem) {
    const observed = this.observeItem(sessionId, turnId, item.id);
    observed.startedItem = item;
  }

  private observeCompletedItem(sessionId: string, turnId: string, item: CodexThreadItem) {
    const observed = this.observeItem(sessionId, turnId, item.id);
    observed.completedItem = item;
  }

  private observeItem(sessionId: string, turnId: string, itemId: string) {
    const turn = this.turnState(sessionId, turnId);
    const current = turn.itemsById.get(itemId);
    if (current) {
      return current;
    }

    const created: ObservedItemState = {
      order: turn.nextOrder++,
      startedItem: null,
      completedItem: null,
      agentText: "",
      planText: "",
      reasoningSummary: [],
      reasoningContent: [],
      commandOutput: ""
    };
    turn.itemsById.set(itemId, created);
    return created;
  }

  private turnState(sessionId: string, turnId: string) {
    let turns = this.turnsBySession.get(sessionId);
    if (!turns) {
      turns = new Map<string, ObservedTurnState>();
      this.turnsBySession.set(sessionId, turns);
    }

    let turn = turns.get(turnId);
    if (!turn) {
      turn = {
        nextOrder: 0,
        itemsById: new Map<string, ObservedItemState>()
      };
      turns.set(turnId, turn);
    }

    return turn;
  }
}

function updateIndexedText(items: readonly string[], index: number, delta: string) {
  const next = [...items];
  const current = next[index] ?? "";
  next[index] = current + delta;
  return next;
}

function sameStringArray(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}
