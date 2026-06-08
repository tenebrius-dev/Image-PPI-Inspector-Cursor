figma.showUI(__html__, {
  width: 320,
  height: 520,
  themeColors: true,
});

type InspectPayload = {
  originalWidth: number;
  originalHeight: number;
  currentWidth: number;
  currentHeight: number;
  effectivePpi: number;
  printWidthMm: number;
};

type OutMessage =
  | { type: 'inspect'; payload: InspectPayload | null; reason?: string }
  | { type: 'resize-done'; ok: boolean; error?: string };

type UiMessage = { type: 'resize-to-target'; targetPpi: number };

function isSupportedNode(node: SceneNode): node is RectangleNode | FrameNode {
  return node.type === 'RECTANGLE' || node.type === 'FRAME';
}

function findImagePaint(node: GeometryMixin & BlendMixin): ImagePaint | null {
  if (node.fills === figma.mixed) {
    return null;
  }
  for (const fill of node.fills) {
    if (fill.type === 'IMAGE' && fill.visible !== false) {
      return fill;
    }
  }
  return null;
}

async function buildInspectPayload(
  node: RectangleNode | FrameNode
): Promise<InspectPayload | null> {
  const paint = findImagePaint(node);
  if (!paint || !paint.imageHash) {
    return null;
  }

  const image = figma.getImageByHash(paint.imageHash);
  if (!image) {
    return null;
  }

  const { width: originalWidth, height: originalHeight } = await image.getSizeAsync();
  const currentWidth = node.width;
  const currentHeight = node.height;

  if (currentWidth <= 0) {
    return null;
  }

  const effectivePpi = originalWidth / (currentWidth / 72);
  const printWidthMm = (currentWidth / 72) * 25.4;

  return {
    originalWidth,
    originalHeight,
    currentWidth,
    currentHeight,
    effectivePpi,
    printWidthMm,
  };
}

async function sendInspectToUI(): Promise<void> {
  const sel = figma.currentPage.selection;

  if (sel.length !== 1) {
    const reason =
      sel.length === 0
        ? 'Select a rectangle or frame with an image fill.'
        : 'Select only one layer.';
    const msg: OutMessage = { type: 'inspect', payload: null, reason };
    figma.ui.postMessage(msg);
    return;
  }

  const node = sel[0];
  if (!isSupportedNode(node)) {
    const msg: OutMessage = {
      type: 'inspect',
      payload: null,
      reason: 'Select a Rectangle or Frame with an image fill.',
    };
    figma.ui.postMessage(msg);
    return;
  }

  try {
    const payload = await buildInspectPayload(node);
    if (!payload) {
      const msg: OutMessage = {
        type: 'inspect',
        payload: null,
        reason: 'No visible image fill found on this layer.',
      };
      figma.ui.postMessage(msg);
      return;
    }
    const msg: OutMessage = { type: 'inspect', payload };
    figma.ui.postMessage(msg);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Could not read image.';
    const msg: OutMessage = { type: 'inspect', payload: null, reason: message };
    figma.ui.postMessage(msg);
  }
}

figma.on('selectionchange', () => {
  void sendInspectToUI();
});

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type !== 'resize-to-target') {
    return;
  }

  const targetPpi = msg.targetPpi;
  if (!Number.isFinite(targetPpi) || targetPpi <= 0) {
    figma.ui.postMessage({
      type: 'resize-done',
      ok: false,
      error: 'Target PPI must be a positive number.',
    } satisfies OutMessage);
    figma.notify('Target PPI must be a positive number.', { error: true });
    return;
  }

  const sel = figma.currentPage.selection;
  if (sel.length !== 1 || !isSupportedNode(sel[0])) {
    figma.ui.postMessage({ type: 'resize-done', ok: false, error: 'Invalid selection.' } satisfies OutMessage);
    figma.notify('Invalid selection.', { error: true });
    return;
  }

  const node = sel[0];
  const paint = findImagePaint(node);
  if (!paint || !paint.imageHash) {
    figma.ui.postMessage({ type: 'resize-done', ok: false, error: 'No image fill.' } satisfies OutMessage);
    figma.notify('No image fill on this layer.', { error: true });
    return;
  }

  const image = figma.getImageByHash(paint.imageHash);
  if (!image) {
    figma.ui.postMessage({ type: 'resize-done', ok: false, error: 'Image not found.' } satisfies OutMessage);
    figma.notify('Image not found.', { error: true });
    return;
  }

  try {
    const { width: originalWidth } = await image.getSizeAsync();
    const w = node.width;
    const h = node.height;
    if (w <= 0) {
      figma.ui.postMessage({
        type: 'resize-done',
        ok: false,
        error: 'Layer width is zero.',
      } satisfies OutMessage);
      figma.notify('Layer width is zero.', { error: true });
      return;
    }

    const newWidth = (originalWidth * 72) / targetPpi;
    const scale = newWidth / w;
    const newHeight = h * scale;

    node.resize(newWidth, newHeight);

    figma.ui.postMessage({ type: 'resize-done', ok: true } satisfies OutMessage);
    figma.notify(`Resized to ${targetPpi} PPI (width).`);
    await sendInspectToUI();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Resize failed.';
    figma.ui.postMessage({ type: 'resize-done', ok: false, error: message } satisfies OutMessage);
    figma.notify(message, { error: true });
  }
};

void sendInspectToUI();
