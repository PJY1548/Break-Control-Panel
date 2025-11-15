const express = require('express');
const { exec } = require('child_process');
const si = require('systeminformation');
const bcrypt = require('bcryptjs');
const path = require('path');
const { format } = require('date-fns');
const fs = require('fs').promises;
const fsSync = require('fs');
const fsExtra = require('fs-extra');
const mammoth = require('mammoth');
const mime = require('mime-types');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 网盘根目录配置
const CLOUD_DIR = 'C:\\cloud_data';
const CLOUD_ROOT = path.resolve(CLOUD_DIR);
fsExtra.ensureDirSync(CLOUD_DIR);

// 管理员密码哈希（请替换为实际密码哈希）
const passwordHash = '$hashplaceholder$';

// 文件上传配置
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const requestedPath = (req.query && req.query.path) || req.body.path || '';
            const targetDir = path.join(CLOUD_ROOT, requestedPath || '');
            fsExtra.ensureDirSync(targetDir);
            cb(null, targetDir);
        },
        filename: (req, file, cb) => {
            const originalName = Buffer.from(file.originalname || '', 'latin1').toString('utf8');
            const ext = path.extname(originalName);
            const name = path.basename(originalName, ext);
            const requestedPath = (req.query && req.query.path) || req.body.path || '';
            const targetDir = path.join(CLOUD_ROOT, requestedPath || '');
            let finalName = `${name}${ext}`;
            let counter = 1;
            while (fsExtra.existsSync(path.join(targetDir, finalName))) {
                finalName = `${name} (${counter})${ext}`;
                counter += 1;
            }
            cb(null, finalName);
        }
    }),
    limits: { fileSize: 1024 * 1024 * 10000 } // 限制10GB
});

// 系统状态缓存
const systemStatusCache = {
    cpu: 0,
    memory: 0,
    lastUpdated: new Date().toISOString()
};

// 日志工具
const log = (message, type = 'info') => {
    const time = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    console.log(`[${time}] [${type.toUpperCase()}] ${message}`);
};

// 同步密码验证（本地管理面板场景适用）
const verifyPassword = (inputPassword) => bcrypt.compareSync(inputPassword, passwordHash);

// 校验用户路径是否位于云盘根目录内，防止越界访问
const isValidPath = (userPath) => {
    try {
        const fullPath = path.resolve(CLOUD_ROOT, userPath || '');
        const relative = path.relative(CLOUD_ROOT, fullPath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    } catch (err) {
        return false;
    }
};

// 定时更新系统状态（每5秒）
const updateSystemStatus = async () => {
    try {
        log('开始更新系统状态');
        const [cpuLoad, memory] = await Promise.all([
            si.currentLoad(),
            si.mem()
        ]);
        systemStatusCache.cpu = Math.round(cpuLoad.currentLoad || 0);
        systemStatusCache.memory = Math.round((memory.used / memory.total) * 100 || 0);
        systemStatusCache.lastUpdated = new Date().toISOString();
        log('系统状态更新成功');
    } catch (error) {
        log(`状态更新失败: ${error.message}`, 'error');
        try {
            const memory = await si.mem();
            systemStatusCache.memory = Math.round((memory.used / memory.total) * 100 || 0);
        } catch (memError) {
            log(`内存信息更新失败: ${memError.message}`, 'error');
        }
    }
};

updateSystemStatus();
setInterval(updateSystemStatus, 5000);

// 接口：获取系统状态
app.get('/api/status', (req, res) => {
    res.json({
        ...systemStatusCache,
        clientIp: req.ip
    });
});

// 验证密码接口（前端可用来验证密码是否正确）
app.post('/api/auth/verify', (req, res) => {
    try {
        const password = req.body.password;
        if (!password) return res.json({ success: false, message: '未提供密码' });
        const ok = verifyPassword(password);
        if (ok) return res.json({ success: true, message: '密码正确' });
        return res.json({ success: false, message: '密码错误' });
    } catch (error) {
        return res.json({ success: false, message: error.message });
    }
});

// 系统控制接口（关机、重启、睡眠）
app.post('/api/shutdown', async (req, res) => {
    if (!verifyPassword(req.body.password)) {
        log(`关机尝试失败: 密码错误 (IP: ${req.ip})`, 'warn');
        return res.json({ success: false, message: '密码错误' });
    }
    log(`执行关机命令 (IP: ${req.ip})`, 'warn');
    exec('shutdown /s /t 0', (error) => {
        res.json({ success: !error, message: error ? `执行失败: ${error.message}` : '关机命令已执行' });
    });
});

app.post('/api/restart', (req, res) => {
    if (!verifyPassword(req.body.password)) {
        log(`重启尝试失败: 密码错误 (IP: ${req.ip})`, 'warn');
        return res.json({ success: false, message: '密码错误' });
    }
    log(`执行重启命令 (IP: ${req.ip})`, 'warn');
    exec('shutdown /r /t 0', (error) => {
        res.json({ success: !error, message: error ? `执行失败: ${error.message}` : '重启命令已执行' });
    });
});

app.post('/api/sleep', (req, res) => {
    if (!verifyPassword(req.body.password)) {
        log(`睡眠尝试失败: 密码错误 (IP: ${req.ip})`, 'warn');
        return res.json({ success: false, message: '密码错误' });
    }
    log(`执行睡眠命令 (IP: ${req.ip})`, 'warn');
    exec('rundll32.exe powrprof.dll,SetSuspendState 0,1,0', (error) => {
        res.json({ success: !error, message: error ? `执行失败: ${error.message}` : '睡眠命令已执行' });
    });
});

// 网盘功能接口
// 1. 获取目录文件列表
app.post('/api/cloud/list', async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) {
            log(`网盘列表访问失败: 密码错误 (IP: ${req.ip})`, 'warn');
            return res.json({ success: false, message: '密码错误' });
        }
        const userPath = req.body.path || '';
        if (!isValidPath(userPath)) {
            return res.json({ success: false, message: '无效路径' });
        }
        const targetDir = path.join(CLOUD_ROOT, userPath);
        const files = await fs.readdir(targetDir, { withFileTypes: true });
        const fileList = await Promise.all(files.map(async (file) => {
            const stats = await fs.stat(path.join(targetDir, file.name));
            return {
                name: file.name,
                isDirectory: file.isDirectory(),
                size: stats.size,
                modified: stats.mtime.toISOString(),
                path: path.join(userPath, file.name)
            };
        }));
        res.json({ success: true, currentPath: userPath, parentPath: path.dirname(userPath) !== userPath ? path.dirname(userPath) : '', files: fileList });
    } catch (error) {
        log(`网盘列表获取失败: ${error.message}`, 'error');
        res.json({ success: false, message: error.message });
    }
});

// 2. 创建文件夹
app.post('/api/cloud/mkdir', async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) return res.json({ success: false, message: '密码错误' });
        const { path: parentPath, name } = req.body;
        if (!name || !isValidPath(parentPath)) return res.json({ success: false, message: '无效参数' });
        const newDirPath = path.join(CLOUD_ROOT, parentPath, name);
        await fs.mkdir(newDirPath, { recursive: true });
        log(`创建文件夹: ${newDirPath} (IP: ${req.ip})`);
        res.json({ success: true, message: '文件夹创建成功' });
    } catch (error) {
        log(`创建文件夹失败: ${error.message}`, 'error');
        res.json({ success: false, message: error.message });
    }
});

// 3. 上传文件
app.post('/api/cloud/upload', upload.single('file'), async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) {
            if (req.file) await fs.unlink(req.file.path);
            return res.json({ success: false, message: '密码错误' });
        }
        if (!req.file) return res.json({ success: false, message: '未找到文件' });
        log(`文件上传成功: ${req.file.path} (IP: ${req.ip})`);
        res.json({ success: true, message: '文件上传成功', filename: req.file.filename, path: path.join(req.body.path || '', req.file.filename) });
    } catch (error) {
        log(`文件上传失败: ${error.message}`, 'error');
        res.json({ success: false, message: error.message });
    }
});

// 4. 下载文件
app.post('/api/cloud/download', async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) return res.json({ success: false, message: '密码错误' });
        const { path: filePath } = req.body;
        if (!filePath) return res.json({ success: false, message: '未提供路径' });
        if (!isValidPath(filePath)) return res.json({ success: false, message: '无效路径' });
        const fullPath = path.resolve(CLOUD_ROOT, filePath);
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) return res.json({ success: false, message: '不能下载文件夹' });
        const filename = path.basename(fullPath);
        const encodedFilename = encodeURIComponent(filename);
        const asciiFilename = filename.replace(/[^ -]/g, '_').replace(/"/g, '');
        const disposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
        res.setHeader('Content-Disposition', disposition);
        const lookupType = mime.lookup(fullPath) || 'application/octet-stream';
        res.setHeader('Content-Type', lookupType);
        res.setHeader('Content-Length', stats.size);
        const stream = fsSync.createReadStream(fullPath);
        stream.on('error', (err) => { log(`文件流出错: ${err.message}`, 'error'); if (!res.headersSent) { res.status(500).json({ success: false, message: '读取文件失败' }); } else { res.destroy(); } });
        stream.pipe(res);
        stream.on('end', () => { log(`文件下载完成: ${fullPath} (IP: ${req.ip})`); });
    } catch (error) { log(`文件下载失败: ${error.message}`, 'error'); res.json({ success: false, message: error.message }); }
});

//（GET），便于浏览器直接通过链接下载大文件
app.get('/api/cloud/download', async (req, res) => {
    try {
        const password = req.query.password;
        const filePath = req.query.path;
        if (!verifyPassword(password)) return res.status(401).json({ success: false, message: '密码错误' });
        if (!filePath) return res.status(400).json({ success: false, message: '未提供路径' });
        if (!isValidPath(filePath)) return res.status(400).json({ success: false, message: '无效路径' });
        const fullPath = path.resolve(CLOUD_ROOT, filePath);
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) return res.status(400).json({ success: false, message: '不能下载文件夹' });
        const inline = req.query.inline === '1' || req.query.inline === 'true';
        const lookupTypeRaw = mime.lookup(fullPath) || 'application/octet-stream';
        let contentType = lookupTypeRaw;
        try { if (/^text\//.test(lookupTypeRaw) && !/charset=/i.test(lookupTypeRaw)) contentType = lookupTypeRaw + '; charset=utf-8'; } catch (e) { contentType = lookupTypeRaw; }
        const range = req.headers.range;
        const fileSize = stats.size;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) { res.status(416).setHeader('Content-Range', `bytes */${fileSize}`); return res.end(); }
            const chunkSize = (end - start) + 1;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', chunkSize);
            res.setHeader('Content-Type', contentType);
            if (!inline) {
                const filename = path.basename(fullPath);
                const encodedFilename = encodeURIComponent(filename);
                const asciiFilename = filename.replace(/[^ -]/g, '_').replace(/"/g, '');
                const disposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
                res.setHeader('Content-Disposition', disposition);
            }
            const stream = fsSync.createReadStream(fullPath, { start, end });
            stream.on('error', (err) => { log(`文件流出错: ${err.message}`, 'error'); try { res.destroy(); } catch (e) {} });
            stream.pipe(res);
            stream.on('end', () => log(`文件部分/下载完成: ${fullPath} (IP: ${req.ip})`));
            return;
        }
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', contentType);
        if (!inline) {
            const filename = path.basename(fullPath);
            const encodedFilename = encodeURIComponent(filename);
            const asciiFilename = filename.replace(/[^ -]/g, '_').replace(/"/g, '');
            const disposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
            res.setHeader('Content-Disposition', disposition);
        }
        const stream = fsSync.createReadStream(fullPath);
        stream.on('error', (err) => { log(`文件流出错: ${err.message}`, 'error'); if (!res.headersSent) { res.status(500).json({ success: false, message: '读取文件失败' }); } else { res.destroy(); } });
        stream.pipe(res);
        stream.on('end', () => log(`文件下载完成: ${fullPath} (IP: ${req.ip})`));
    } catch (error) { log(`文件下载失败: ${error.message}`, 'error'); if (!res.headersSent) { res.status(500).json({ success: false, message: error.message }); } }
});

// 支持路径形式的下载 URL，便于 epub.js 使用相对路径
app.get('/api/cloud/download/*', async (req, res) => {
    try {
        const encodedPath = req.params[0] || '';
        const filePathFromUrl = decodeURIComponent(encodedPath);
        const password = req.query.password;
        const inline = req.query.inline === '1' || req.query.inline === 'true';
        if (!verifyPassword(password)) return res.status(401).json({ success: false, message: '密码错误' });
        if (!filePathFromUrl) return res.status(400).json({ success: false, message: '未提供路径' });
        if (!isValidPath(filePathFromUrl)) return res.status(400).json({ success: false, message: '无效路径' });
        const fullPath = path.resolve(CLOUD_ROOT, filePathFromUrl);
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) return res.status(400).json({ success: false, message: '不能下载文件夹' });
        const lookupTypeRaw = mime.lookup(fullPath) || 'application/octet-stream';
        let contentType = lookupTypeRaw;
        try { if (/^text\//.test(lookupTypeRaw) && !/charset=/i.test(lookupTypeRaw)) contentType = lookupTypeRaw + '; charset=utf-8'; } catch (e) { contentType = lookupTypeRaw; }
        const range = req.headers.range;
        const fileSize = stats.size;
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            if (isNaN(start) || isNaN(end) || start > end || end >= fileSize) { res.status(416).setHeader('Content-Range', `bytes */${fileSize}`); return res.end(); }
            const chunkSize = (end - start) + 1;
            res.status(206);
            res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Length', chunkSize);
            res.setHeader('Content-Type', contentType);
            if (!inline) {
                const filename = path.basename(fullPath);
                const encodedFilename = encodeURIComponent(filename);
                const asciiFilename = filename.replace(/[^ -]/g, '_').replace(/"/g, '');
                const disposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
                res.setHeader('Content-Disposition', disposition);
            }
            const stream = fsSync.createReadStream(fullPath, { start, end });
            stream.on('error', (err) => { log(`文件流出错: ${err.message}`, 'error'); try { res.destroy(); } catch (e) {} });
            stream.pipe(res);
            stream.on('end', () => log(`文件部分/下载完成 (path-segment): ${fullPath} (IP: ${req.ip})`));
            return;
        }
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', fileSize);
        res.setHeader('Content-Type', contentType);
        if (!inline) {
            const filename = path.basename(fullPath);
            const encodedFilename = encodeURIComponent(filename);
            const asciiFilename = filename.replace(/[^ -]/g, '_').replace(/"/g, '');
            const disposition = `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
            res.setHeader('Content-Disposition', disposition);
        }
        const stream = fsSync.createReadStream(fullPath);
        stream.on('error', (err) => { log(`文件流出错: ${err.message}`, 'error'); if (!res.headersSent) { res.status(500).json({ success: false, message: '读取文件失败' }); } else { res.destroy(); } });
        stream.pipe(res);
        stream.on('end', () => log(`文件下载完成 (path-segment): ${fullPath} (IP: ${req.ip})`));
    } catch (error) { log(`文件下载失败 (path-segment): ${error.message}`, 'error'); if (!res.headersSent) { res.status(500).json({ success: false, message: error.message }); } }
});

// 5. 删除文件/文件夹
app.post('/api/cloud/delete', async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) return res.json({ success: false, message: '密码错误' });
        const { path: targetPath } = req.body;
        if (!isValidPath(targetPath)) return res.json({ success: false, message: '无效路径' });
        const fullPath = path.join(CLOUD_ROOT, targetPath);
        await fsExtra.remove(fullPath);
        log(`删除成功: ${fullPath} (IP: ${req.ip})`);
        res.json({ success: true, message: '删除成功' });
    } catch (error) { log(`删除失败: ${error.message}`, 'error'); res.json({ success: false, message: error.message }); }
});


// 6. 重命名文件/文件夹
app.post('/api/cloud/rename', async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) return res.json({ success: false, message: '密码错误' });
        const oldPath = req.body.path;
        const newName = req.body.newName;
        if (!oldPath || !newName) return res.json({ success: false, message: '缺少参数: path 或 newName' });
        if (!isValidPath(oldPath)) return res.json({ success: false, message: '无效的原始路径' });
        if (path.basename(newName) !== newName || newName.indexOf(path.sep) !== -1) return res.json({ success: false, message: '无效的新名称' });
        const oldFull = path.resolve(CLOUD_ROOT, oldPath);
        const parentDir = path.dirname(oldPath);
        const destDir = path.resolve(CLOUD_ROOT, parentDir || '');
        const oldStats = await fs.stat(oldFull);
        const ext = path.extname(newName);
        const base = path.basename(newName, ext);
        let candidate = newName;
        let counter = 1;
        while (fsExtra.existsSync(path.join(destDir, candidate))) { candidate = `${base} (${counter})${ext}`; counter += 1; }
        const newFull = path.join(destDir, candidate);
        await fsExtra.move(oldFull, newFull);
        log(`重命名成功: ${oldFull} -> ${newFull} (IP: ${req.ip})`);
        const relativeNew = path.relative(CLOUD_ROOT, newFull).split(path.sep).join('/');
        res.json({ success: true, message: '重命名成功', newName: candidate, newPath: relativeNew });
    } catch (error) { log(`重命名失败: ${error.message}`, 'error'); res.json({ success: false, message: error.message }); }
});

// 7. 批量移动文件/文件夹
app.post('/api/cloud/move', async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) return res.json({ success: false, message: '密码错误' });
        const items = req.body.items;
        const targetPath = req.body.targetPath || '';
        if (!Array.isArray(items) || items.length === 0) return res.json({ success: false, message: '未提供要移动的项' });
        if (!isValidPath(targetPath)) return res.json({ success: false, message: '目标路径无效' });
        const results = [];
        const destDir = path.resolve(CLOUD_ROOT, targetPath || '');
        await fsExtra.ensureDir(destDir);
        for (const rel of items) {
            if (!isValidPath(rel)) { results.push({ item: rel, success: false, message: '无效路径' }); continue; }
            const srcFull = path.resolve(CLOUD_ROOT, rel);
            try {
                const stats = await fs.stat(srcFull);
                const baseName = path.basename(rel);
                let candidate = baseName;
                let counter = 1;
                while (fsExtra.existsSync(path.join(destDir, candidate))) { const ext = path.extname(baseName); const nameOnly = path.basename(baseName, ext); candidate = `${nameOnly} (${counter})${ext}`; counter += 1; }
                const destFull = path.join(destDir, candidate);
                await fsExtra.move(srcFull, destFull);
                results.push({ item: rel, success: true, dest: path.relative(CLOUD_ROOT, destFull).split(path.sep).join('/') });
            } catch (err) { results.push({ item: rel, success: false, message: err.message }); }
        }
        const moved = results.filter(r => r.success).length;
        log(`批量移动: ${moved}/${items.length} (IP: ${req.ip})`);
        res.json({ success: true, message: '批量移动完成', moved, results });
    } catch (error) { log(`批量移动失败: ${error.message}`, 'error'); res.json({ success: false, message: error.message }); }
});

// 8. 搜索文件（在指定目录下递归查找匹配的文件名）
app.post('/api/cloud/search', async (req, res) => {
    try {
        if (!verifyPassword(req.body.password)) return res.json({ success: false, message: '密码错误' });
        const userPath = req.body.path || '';
        const query = (req.body.query || '').trim();
        const types = Array.isArray(req.body.types) ? req.body.types : null;
        if (!isValidPath(userPath)) return res.json({ success: false, message: '无效路径' });
        const startDir = path.resolve(CLOUD_ROOT, userPath || '');
        const results = [];
        async function walk(dir) {
            const items = await fs.readdir(dir, { withFileTypes: true });
            for (const it of items) {
                const full = path.join(dir, it.name);
                const rel = path.relative(CLOUD_ROOT, full).split(path.sep).join('/');
                if (it.isDirectory()) { await walk(full); } else {
                    if (types && types.length > 0) {
                        const ext = path.extname(it.name).toLowerCase().replace('.', '');
                        const map = { image: ['jpg','jpeg','png','gif','bmp','webp','svg'], video: ['mp4','mkv','mov','avi','webm'], audio: ['mp3','wav','ogg','flac'], text: ['txt','md','json','xml','log','csv'], doc: ['pdf','doc','docx','epub'] };
                        let matchedType = false;
                        for (const t of types) { const arr = map[t]; if (arr && arr.includes(ext)) { matchedType = true; break; } }
                        if (!matchedType) continue;
                    }
                    if (!query || it.name.toLowerCase().includes(query.toLowerCase())) {
                        const stats = await fs.stat(full);
                        results.push({ name: it.name, path: rel, size: stats.size, modified: stats.mtime.toISOString(), isDirectory: false });
                    }
                }
            }
        }
        await walk(startDir);
        res.json({ success: true, files: results, currentPath: userPath });
    } catch (err) {
        log(`搜索失败: ${err.message}`, 'error');
        res.json({ success: false, message: err.message });
    }
});

// 9. 预览接口：docx 转 HTML、epub 返回 mime，其他类型代理到 download with inline
app.get('/api/cloud/preview', async (req, res) => {
    try {
        const password = req.query.password;
        const filePath = req.query.path;
        if (!verifyPassword(password)) return res.status(401).json({ success: false, message: '密码错误' });
        if (!filePath) return res.status(400).json({ success: false, message: '未提供路径' });
        if (!isValidPath(filePath)) return res.status(400).json({ success: false, message: '无效路径' });
        const fullPath = path.resolve(CLOUD_ROOT, filePath);
        const stats = await fs.stat(fullPath);
        if (stats.isDirectory()) return res.status(400).json({ success: false, message: '不能预览文件夹' });
        const ext = path.extname(fullPath).toLowerCase().replace('.', '');
        if (ext === 'docx') {
            try { const result = await mammoth.convertToHtml({ path: fullPath }); const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family: system-ui, Arial, sans-serif;padding:16px;}</style></head><body>${result.value}</body></html>`; res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.send(html); } catch (err) { log(`docx 转换失败: ${err.message}`, 'error'); return res.status(500).json({ success: false, message: 'DOCX 转换失败' }); }
        }
        if (ext === 'epub') { const q = new URLSearchParams({ password: req.query.password || '', path: filePath, inline: '1' }).toString(); return res.redirect(`/api/cloud/download?${q}`); }
        const q = new URLSearchParams({ password: req.query.password || '', path: filePath, inline: '1' }).toString();
        return res.redirect(`/api/cloud/download?${q}`);
    } catch (err) {
        log(`预览失败: ${err.message}`, 'error');
        if (!res.headersSent) return res.status(500).json({ success: false, message: err.message });
    }
});

// 启动服务
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
    log(`服务已启动，访问 http://localhost:${PORT}`);
    log(`网盘根目录: ${CLOUD_DIR}`);
    log('提示：请以管理员身份运行，否则可能无法执行系统命令');
});

