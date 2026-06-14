// Инициализация UI
figma.showUI(__html__, { width: 300, height: 500, themeColors: true });

figma.skipInvisibleInstanceChildren = true; 

const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 15));

let cancelScanRequested = false;

function clone(val: any): any {
    return JSON.parse(JSON.stringify(val));
}

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

async function findAllImageNodesAsync(nodes: readonly BaseNode[]): Promise<SceneNode[]> {
    let imageNodes: SceneNode[] = [];
    let counter = 0; 
    async function traverse(currentNodes: readonly BaseNode[]) {
        for (const node of currentNodes) {
            if (cancelScanRequested) return;
            if ('visible' in node && !node.visible) continue;
            
            if ('fills' in node && node.fills !== figma.mixed && Array.isArray(node.fills)) {
                if (node.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash)) {
                    imageNodes.push(node as SceneNode);
                }
            }
            if ('children' in node) {
                await traverse((node as any).children);
            }
            counter++;
            if (counter % 300 === 0) await yieldToUI(); 
        }
    }
    await traverse(nodes);
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

        const t00 = transform ? transform[0][0] : 1;
        const t11 = transform ? transform[1][1] : 1;
        const t02 = transform ? transform[0][2] : 0;
        const t12 = transform ? transform[1][2] : 0;
        
        const posX = t00 !== 0 ? (-t02 / t00) * nodeWidth : 0;
        const posY = t11 !== 0 ? (-t12 / t11) * nodeHeight : 0;

        const ppiX = size.width / (nodeWidth / scaleX / 72);
        const ppiY = size.height / (nodeHeight / scaleY / 72);
        const stablePPI = Math.round((ppiX + ppiY) / 2);

        let hasCC = false;
        if (fill.filters) {
            const f = fill.filters;
            if (
                Math.abs(f.exposure || 0) > 0.001 || 
                Math.abs(f.contrast || 0) > 0.001 || 
                Math.abs(f.saturation || 0) > 0.001 || 
                Math.abs(f.temperature || 0) > 0.001 || 
                Math.abs(f.tint || 0) > 0.001 || 
                Math.abs(f.highlights || 0) > 0.001 || 
                Math.abs(f.shadows || 0) > 0.001
            ) {
                hasCC = true;
            }
        }
        
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
            aspectRatio: nodeHeight / nodeWidth,
            hasCC: hasCC
        };
    } catch (err) {
        console.error(`Error processing node ${node.id}`, err);
        return null;
    }
}

async function checkSelection() {
    const selection = figma.currentPage.selection;
    
    if (selection.length === 0) {
        figma.ui.postMessage({ type: "clear" });
        return;
    }
    
    const imageNodes = findAllImageNodes(selection);
    
    if (imageNodes.length === 1) {
        // Одно изображение — показываем детали автоматически
        const data = await calculateNodeData(imageNodes[0]);
        if (data) {
            figma.ui.postMessage({ 
                type: "images-list", 
                images: [data],
                selectedIds: selection.map(node => node.id)
            });
        }
        return;
    }
    
    // 0 или несколько изображений — не сканируем автоматически, обновляем кнопку в UI
    figma.ui.postMessage({ type: "selection-context", hasSelection: true });
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
    
    if (msg.type === 'restore-selection' && msg.nodeIds) {
        try {
            const nodes = [];
            for (const id of msg.nodeIds) {
                const node = await figma.getNodeByIdAsync(id);
                if (node) nodes.push(node);
            }
            figma.currentPage.selection = nodes;
        } catch (e) {
            console.error("Failed to restore initial selection", e);
        }
    }

    if (msg.type === 'cancel-scan') {
        cancelScanRequested = true;
    }
    
    if (msg.type === 'scan') {
        cancelScanRequested = false;
        await yieldToUI();

        let nodesToScan = msg.scope === 'selection' ? figma.currentPage.selection : msg.scope === 'project' ? figma.root.children : figma.currentPage.children;
        const allImageNodes = await findAllImageNodesAsync(nodesToScan);
        
        if (cancelScanRequested) {
            figma.ui.postMessage({ type: "scan-cancelled" });
            return;
        }

        const total = allImageNodes.length;

        if (total === 0) {
            figma.ui.postMessage({ type: "scan-results", images: [], ccImages: msg.includeCC ? [] : null, total: 0 });
            return;
        }

        const resultsPPI = [];
        const resultsCC = [];

        for (let i = 0; i < total; i++) {
            if (cancelScanRequested) {
                figma.ui.postMessage({ type: "scan-cancelled" });
                return;
            }

            const node = allImageNodes[i];
            const data = await calculateNodeData(node);
            
            if (data) {
                if (data.ppi < 250) resultsPPI.push(data);
                if (msg.includeCC && data.hasCC) resultsCC.push(data);
            }

            if (i % 2 === 0 || i === total - 1) {
                figma.ui.postMessage({ type: "scan-progress", current: i + 1, total: total });
                await yieldToUI(); 
            }
        }

        if (cancelScanRequested) {
            figma.ui.postMessage({ type: "scan-cancelled" });
            return;
        }

        resultsPPI.sort((a, b) => a.ppi - b.ppi);
        figma.ui.postMessage({ 
            type: "scan-results", 
            images: resultsPPI, 
            ccImages: msg.includeCC ? resultsCC : null,
            total: total 
        });
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
        }
    }

    if (msg.type === 'download-image-cc' && msg.nodeId) {
        let tempRect: RectangleNode | null = null;
        try {
            const node = await figma.getNodeByIdAsync(msg.nodeId) as SceneNode;
            if (!node) throw new Error("Layer not found.");

            if (!('fills' in node) || node.fills === figma.mixed || !Array.isArray(node.fills)) {
                throw new Error("No valid fills found.");
            }
            
            const originalFill = node.fills.find(f => f.type === 'IMAGE');
            if (!originalFill || !originalFill.imageHash) throw new Error("No image fill.");
            
            const image = figma.getImageByHash(originalFill.imageHash);
            if (!image) throw new Error("No image.");

            const size = await image.getSizeAsync();
            
            // Временная нода для рендера
            tempRect = figma.createRectangle();
            tempRect.name = "Export_Temp";
            tempRect.resize(size.width, size.height);
            tempRect.x = node.x - 20000;
            tempRect.y = node.y;
            
            const newFill = clone(originalFill);
            newFill.scaleMode = 'FILL';
            delete newFill.imageTransform;
            
            tempRect.fills = [newFill];

            if (node.parent) {
                node.parent.insertChild(0, tempRect);
            } else {
                figma.currentPage.appendChild(tempRect);
            }

            const exportScale = size.width / tempRect.width;

            // Подставляем формат ресамплинга "BASIC", который эквивалентен отключению интерполяции
            const exportSettings: any = { 
                format: 'PNG',
                constraint: { type: 'SCALE', value: exportScale },
                imageResampling: 'BASIC'
            };

            const bytes = await tempRect.exportAsync(exportSettings);
            figma.ui.postMessage({ type: 'download-file', bytes: bytes, name: node.name + "_CC" });
        } catch (err: any) {
            figma.notify("Error downloading CC image: " + err.message);
        } finally {
            // Гарантируем удаление временной ноды даже при ошибке
            if (tempRect) tempRect.remove();
        }
    }
};