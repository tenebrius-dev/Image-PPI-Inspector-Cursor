figma.showUI(__html__, { width: 300, height: 100 });

function findAllImageNodes(nodes: readonly SceneNode[]): SceneNode[] {
  let imageNodes: SceneNode[] = [];
  for (const node of nodes) {
    if (!node.visible) continue;
    if ('fills' in node && Array.isArray(node.fills)) {
      if (node.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash)) {
        imageNodes.push(node);
      }
    }
    if ('findAll' in node) {
      const children = node.findAll(child => 
        child.visible && 
        'fills' in child && 
        Array.isArray(child.fills) && 
        child.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash)
      );
      imageNodes = imageNodes.concat(children as SceneNode[]);
    }
  }
  return imageNodes;
}

async function getImageData(node: SceneNode) {
  const fill = (node as any).fills.find(f => f.type === 'IMAGE');
  const image = figma.getImageByHash(fill.imageHash);
  let size;
  try { size = await image.getSizeAsync(); } catch (e) { await image.getBytesAsync(); size = await image.getSizeAsync(); }
  const transform = fill.imageTransform;
  const scaleX = transform ? transform[0][0] : 1;
  const scaleY = transform ? transform[1][1] : 1;
  const ppiX = size.width / (node.width / scaleX / 72);
  const ppiY = size.height / (node.height / scaleY / 72);
  return {
    id: node.id, name: node.name, ppi: (ppiX + ppiY) / 2,
    resScaleX: (72 / ppiX) * 100, resScaleY: (72 / ppiY) * 100,
    curW: node.width, curH: node.height, origW: size.width, origH: size.height,
    printW: (node.width / 72) * 25.4, printH: (node.height / 72) * 25.4,
    aspectRatio: node.height / node.width
  };
}

async function checkSelection() {
  const selection = figma.currentPage.selection;
  const imageNodes = findAllImageNodes(selection);
  if (imageNodes.length === 0) { figma.ui.postMessage({ type: "clear" }); return; }
  const imagesData = await Promise.all(imageNodes.map(node => getImageData(node)));
  figma.ui.postMessage({ type: "images-list", images: imagesData });
}

figma.on("selectionchange", checkSelection);
figma.on("documentchange", (e) => {
  if (e.documentChanges.some(c => c.type === 'PROPERTY_CHANGE' && figma.currentPage.selection.some(n => n.id === c.id))) checkSelection();
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'resize-window') figma.ui.resize(msg.width, msg.height);
  if (msg.type === 'notify') figma.notify(msg.msg);
  if (msg.type === 'focus-node') {
    const node = figma.getNodeById(msg.nodeId) as SceneNode;
    if (node) { figma.currentPage.selection = [node]; figma.viewport.scrollAndZoomIntoView([node]); }
  }
  if (msg.type === 'scan-page') {
    const nodes = findAllImageNodes(figma.currentPage.children);
    const total = nodes.length;
    if (total === 0) { figma.ui.postMessage({ type: "scan-results", images: [], total: 0 }); return; }
    const results = [];
    let processed = 0;
    for (const node of nodes) {
      processed++;
      figma.ui.postMessage({ type: "scan-progress", current: processed, total: total });
      const data = await getImageData(node);
      if (data.ppi < 250) results.push(data);
      if (processed % 5 === 0) await new Promise(r => setTimeout(r, 1));
    }
    results.sort((a, b) => a.ppi - b.ppi);
    figma.ui.postMessage({ type: "scan-results", images: results, total: total });
  }
  if (msg.type === 'resize') {
    const node = figma.getNodeById(msg.nodeId) as GeometryMixin & LayoutMixin;
    if (node) {
      const newWidth = (msg.origW / msg.targetPpi) * 72;
      node.resize(newWidth, newWidth * msg.aspectRatio);
      checkSelection();
      figma.notify(`✅ Resized to ${msg.targetPpi} PPI`);
    }
  }
  if (msg.type === 'download-image') {
    const node = figma.getNodeById(msg.nodeId) as any;
    const fill = node.fills.find(f => f.type === 'IMAGE');
    const image = figma.getImageByHash(fill.imageHash);
    const bytes = await image.getBytesAsync();
    figma.ui.postMessage({ type: 'download-file', bytes: bytes, name: node.name });
  }
};
checkSelection();