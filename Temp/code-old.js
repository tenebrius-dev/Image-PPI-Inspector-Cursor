var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
figma.showUI(__html__, { width: 300, height: 100 });
function findAllImageNodes(nodes) {
    let imageNodes = [];
    for (const node of nodes) {
        if (!node.visible)
            continue;
        if ('fills' in node && Array.isArray(node.fills)) {
            if (node.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash)) {
                imageNodes.push(node);
            }
        }
        if ('findAll' in node) {
            const children = node.findAll(child => child.visible &&
                'fills' in child &&
                Array.isArray(child.fills) &&
                child.fills.some(fill => fill.type === 'IMAGE' && fill.imageHash));
            imageNodes = imageNodes.concat(children);
        }
    }
    return imageNodes;
}
function checkSelection() {
    return __awaiter(this, void 0, void 0, function* () {
        const selection = figma.currentPage.selection;
        const imageNodes = findAllImageNodes(selection);
        if (imageNodes.length === 0) {
            figma.ui.postMessage({ type: "clear" });
            return;
        }
        const imagesData = yield Promise.all(imageNodes.map((node) => __awaiter(this, void 0, void 0, function* () {
            const fill = node.fills.find(f => f.type === 'IMAGE');
            const image = figma.getImageByHash(fill.imageHash);
            let size;
            try {
                size = yield image.getSizeAsync();
            }
            catch (e) {
                yield image.getBytesAsync();
                size = yield image.getSizeAsync();
            }
            const transform = fill.imageTransform;
            const scaleX = transform ? transform[0][0] : 1;
            const scaleY = transform ? transform[1][1] : 1;
            const ppiX = size.width / (node.width / scaleX / 72);
            const ppiY = size.height / (node.height / scaleY / 72);
            const stablePPI = (ppiX + ppiY) / 2;
            const resScaleX = (72 / ppiX) * 100;
            const resScaleY = (72 / ppiY) * 100;
            return {
                id: node.id,
                name: node.name,
                ppi: stablePPI,
                resScaleX: resScaleX,
                resScaleY: resScaleY,
                curW: node.width,
                curH: node.height,
                origW: size.width,
                origH: size.height,
                printW: (node.width / 72) * 25.4,
                printH: (node.height / 72) * 25.4,
                maxW: (size.width / 300) * 25.4,
                maxH: (size.height / 300) * 25.4,
                aspectRatio: node.height / node.width
            };
        })));
        figma.ui.postMessage({ type: "images-list", images: imagesData });
    });
}
figma.on("selectionchange", checkSelection);
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
checkSelection();
figma.ui.onmessage = (msg) => __awaiter(this, void 0, void 0, function* () {
    if (msg.type === 'resize-window') {
        figma.ui.resize(msg.width, Math.round(msg.height));
    }
    if (msg.type === 'notify' && msg.msg) {
        figma.notify(msg.msg);
    }
    // ФОКУСИРОВКА НА ПРОБЛЕМНОМ УЗЛЕ
    if (msg.type === 'focus-node' && msg.nodeId) {
        const node = figma.getNodeById(msg.nodeId);
        if (node) {
            figma.currentPage.selection = [node];
            figma.viewport.scrollAndZoomIntoView([node]);
        }
    }
    // ЛОГИКА СКАНЕРА ВСЕЙ СТРАНИЦЫ
    if (msg.type === 'scan-page') {
        const allImageNodes = findAllImageNodes(figma.currentPage.children);
        if (allImageNodes.length === 0) {
            figma.ui.postMessage({ type: "scan-results", images: [], total: 0 });
            return;
        }
        const results = [];
        for (const node of allImageNodes) {
            try {
                const fill = node.fills.find(f => f.type === 'IMAGE');
                const image = figma.getImageByHash(fill.imageHash);
                let size;
                try {
                    size = yield image.getSizeAsync();
                }
                catch (e) {
                    yield image.getBytesAsync();
                    size = yield image.getSizeAsync();
                }
                const transform = fill.imageTransform;
                const scaleX = transform ? transform[0][0] : 1;
                const scaleY = transform ? transform[1][1] : 1;
                const ppiX = size.width / (node.width / scaleX / 72);
                const ppiY = size.height / (node.height / scaleY / 72);
                const stablePPI = (ppiX + ppiY) / 2;
                const resScaleX = (72 / ppiX) * 100;
                const resScaleY = (72 / ppiY) * 100;
                // Отбираем только проблемные (ниже 250 PPI) и собираем ПОЛНЫЙ объект данных
                if (stablePPI < 250) {
                    results.push({
                        id: node.id,
                        name: node.name,
                        ppi: stablePPI,
                        resScaleX: resScaleX,
                        resScaleY: resScaleY,
                        curW: node.width,
                        curH: node.height,
                        origW: size.width,
                        origH: size.height,
                        printW: (node.width / 72) * 25.4,
                        printH: (node.height / 72) * 25.4,
                        maxW: (size.width / 300) * 25.4,
                        maxH: (size.height / 300) * 25.4,
                        aspectRatio: node.height / node.width
                    });
                }
            }
            catch (err) {
                console.error("Error processing node", node.id, err);
            }
        }
        // Сортировка: самые проблемные (с наименьшим PPI) наверху
        results.sort((a, b) => a.ppi - b.ppi);
        figma.ui.postMessage({ type: "scan-results", images: results, total: allImageNodes.length });
    }
    if (msg.type === 'resize' && msg.nodeId) {
        const node = figma.getNodeById(msg.nodeId);
        if (node) {
            const newWidth = (msg.origW / msg.targetPpi) * 72;
            node.resize(newWidth, newWidth * msg.aspectRatio);
            checkSelection();
            figma.notify(`✅ Resized to ${msg.targetPpi} PPI`);
        }
    }
    if (msg.type === 'download-image' && msg.nodeId) {
        const node = figma.getNodeById(msg.nodeId);
        const fill = node.fills.find(f => f.type === 'IMAGE');
        if (fill === null || fill === void 0 ? void 0 : fill.imageHash) {
            const image = figma.getImageByHash(fill.imageHash);
            const bytes = yield image.getBytesAsync();
            figma.ui.postMessage({ type: 'download-file', bytes: bytes, name: node.name });
        }
    }
});
