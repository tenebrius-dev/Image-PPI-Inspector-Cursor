figma.showUI(__html__, { width: 300, height: 100 });

// Ускоряем поиск: пропускаем скрытые слои внутри инстансов
figma.skipInvisibleInstanceChildren = true; 

// Увеличиваем паузу до 15мс, чтобы интерфейс успевал перерисовать ползунок
const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 15));

function findAllImageNodes(nodes: readonly SceneNode[]): SceneNode[] {
    let imageNodes: SceneNode[] = [];
    
    for (const node of nodes) {
        if (!node.visible) continue;
        
        if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
            if (node.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash)) {
                imageNodes.push(node);
            }
        }
        
        if ('findAll' in node) {
            const children = node.findAll(child => {
                return child.visible && 
                       'fills' in child && 
                       child.fills !== figma.mixed && 
                       Array.isArray(child.fills) && 
                       child.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash);
            });
            imageNodes = imageNodes.concat(children as SceneNode[]);
        }
    }
    return imageNodes;
}

async function calculateNodeData(node: SceneNode): Promise<any | null> {
    try {
        if (!('fills' in node) || node.fills === figma.mixed || !Array.isArray(node.fills)) return null;
        
        const fill = node.fills.find(f => f.type === 'IMAGE' && f.imageHash);
        if (!fill) return null;

        const image = figma.getImageByHash(fill.imageHash);
        if (!image) return null;

        let size;
        try {
            size = await image.getSizeAsync();
        } catch (e) {
            await image.getBytesAsync();
            size = await image.getSizeAsync();
        }

        const transform = fill.imageTransform;
        const scaleX = transform ? Math.abs(transform[0][0]) : 1;
        const scaleY = transform ? Math.abs(transform[1][1]) : 1;
        
        const nodeWidth = Math.max(node.width, 1);
        const nodeHeight = Math.max(node.height, 1);

        // Конвертация нормализованных долей смещения в физические пиксели холста (canvas pixels)
        const t00 = transform ? transform[0][0] : 1;
        const t11 = transform ? transform[1][1] : 1;
        const t02 = transform ? transform[0][2] : 0;
        const t12 = transform ? transform[1][2] : 0;
        
        const posX = t00 !== 0 ? (-t02 / t00) * nodeWidth : 0;
        const posY = t11 !== 0 ? (-t12 / t11) * nodeHeight : 0;

        const ppiX = size.width / (nodeWidth / scaleX / 72);
        const ppiY = size.height / (nodeHeight / scaleY / 72);
        const stablePPI = (ppiX + ppiY) / 2;
        
        return {
            id: node.id,
            name: node.name,
            ppi: stablePPI,
            posX: posX,
            posY: posY,
            resScaleX: (72 / ppiX) * 100,
            resScaleY: (72 / ppiY) * 100,
            curW: nodeWidth,
            curH: nodeHeight,
            origW: size.width,
            origH: size.height,
            printW: (nodeWidth / 72) * 25.4,
            printH: (nodeHeight / 72) * 25.4,
            maxW: (size.width / 300) * 25.4,
            maxH: (size.height / 300) * 25.4,
            aspectRatio: nodeHeight / nodeWidth
        };
    } catch (err) {
        console.error(`Error processing node ${node.id}`, err);
        return null;
    }
}

async function checkSelection() {
    const selection = figma.currentPage.selection;
    const imageNodes = findAllImageNodes(selection);
    
    if (imageNodes.length === 0) {
        figma.ui.postMessage({ type: "clear" });
        return;
    }
    
    const imagesDataRaw = await Promise.all(imageNodes.map(node => calculateNodeData(node)));
    const imagesData = imagesDataRaw.filter(data => data !== null);
    
    figma.ui.postMessage({ type: "images-list", images: imagesData });
}

figma.on("selectionchange", checkSelection);

figma.loadAllPagesAsync().then(() => {
    figma.on("documentchange", (event) => {
        for (const change of event.documentChanges) {
            if (change.type === 'PROPERTY_CHANGE') {
                const isSelected = figma.currentPage.selection.some(node => node.id === change.id);
                if (isSelected) {
                    checkSelection();
                    break;
                }
            }
        }
    });
});

checkSelection();

figma.ui.onmessage = async (msg) => {
    if (msg.type === 'resize-window') {
        figma.ui.resize(msg.width, Math.round(msg.height));
    }
    
    if (msg.type === 'notify' && msg.msg) {
        figma.notify(msg.msg);
    }
    
    if (msg.type === 'focus-node' && msg.nodeId) {
        try {
            const node = await figma.getNodeByIdAsync(msg.nodeId) as SceneNode;
            if (node) {
                figma.currentPage.selection = [node];
                figma.viewport.scrollAndZoomIntoView([node]);
            }
        } catch (e) {
            console.error("Failed to focus node", e);
        }
    }
    
    if (msg.type === 'scan-page') {
        await yieldToUI();

        const allImageNodes = findAllImageNodes(figma.currentPage.children);
        const total = allImageNodes.length;

        if (total === 0) {
            figma.ui.postMessage({ type: "scan-results", images: [], total: 0 });
            return;
        }

        const results = [];
        
        for (let i = 0; i < total; i++) {
            const node = allImageNodes[i];
            const data = await calculateNodeData(node);
            
            if (data && data.ppi < 250) {
                results.push(data);
            }

            if (i % 2 === 0 || i === total - 1) {
                figma.ui.postMessage({ type: "scan-progress", current: i + 1, total: total });
                await yieldToUI(); 
            }
        }

        results.sort((a, b) => a.ppi - b.ppi);
        figma.ui.postMessage({ type: "scan-results", images: results, total: total });
    }
    
    if (msg.type === 'resize' && msg.nodeId) {
        try {
            const node = await figma.getNodeByIdAsync(msg.nodeId) as SceneNode;
            if (node && 'resize' in node) {
                const newWidth = (msg.origW / msg.targetPpi) * 72;
                node.resize(newWidth, newWidth * msg.aspectRatio);
                checkSelection();
                figma.notify(`✅ Resized to ${msg.targetPpi} PPI`);
            } else {
                figma.notify("❌ Cannot resize this node type.");
            }
        } catch (e) {
            console.error("Resize failed", e);
        }
    }
    
    if (msg.type === 'download-image' && msg.nodeId) {
        try {
            const node = await figma.getNodeByIdAsync(msg.nodeId) as SceneNode;
            if (!node) throw new Error("Layer not found.");

            if (!('fills' in node) || node.fills === figma.mixed || !Array.isArray(node.fills)) {
                throw new Error("No valid fills found.");
            }

            const fill = node.fills.find(f => f.type === 'IMAGE');
            if (!fill || !fill.imageHash) throw new Error("No image fill found.");

            const image = figma.getImageByHash(fill.imageHash);
            if (!image) throw new Error("Image not found in Figma memory.");

            const bytes = await image.getBytesAsync();
            figma.ui.postMessage({ type: 'download-file', bytes: bytes, name: node.name });
            
        } catch (err: any) {
            figma.notify("❌ " + err.message);
            figma.ui.postMessage({ type: 'download-error' });
        }
    }
};