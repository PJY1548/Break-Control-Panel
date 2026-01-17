<#
.SYNOPSIS
配置系统面板的云盘路径和管理员密码（包含环境检查和依赖安装）- 修复替换无效问题
#>

# 确保UTF-8编码输出（解决中文显示问题）
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host "`n===== 环境检查与依赖安装 =====" -ForegroundColor Green

# 检查 Node.js 和 npm 是否可用
Write-Host "`n[1/2] 检查 Node.js 和 npm 环境..." -ForegroundColor Cyan
try {
    # 检查 Node 版本
    $nodeVersion = node -v 2>&1
    if (-not $nodeVersion -or $nodeVersion -match "error") {
        throw "未找到 Node.js，请先安装 Node.js (https://nodejs.org/)"
    }
    Write-Host "✅ Node.js 已安装: $nodeVersion"

    # 检查 npm 版本
    $npmVersion = npm -v 2>&1
    if (-not $npmVersion -or $npmVersion -match "error") {
        throw "未找到 npm，请确保 Node.js 安装正确"
    }
    Write-Host "✅ npm 已安装: v$npmVersion"
}
catch {
    Write-Error "环境检查失败: $_"
    exit 1
}

# 安装其他项目依赖
Write-Host "`n[2/2] 安装项目其他依赖..." -ForegroundColor Cyan
try {
    $installAllOutput = npm install 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "项目依赖安装失败`n$installAllOutput"
    }
    Write-Host "✅ 所有依赖安装完成"
}
catch {
    Write-Error "依赖安装失败: $_"
    exit 1
}

Write-Host "`n===== 开始系统配置 =====" -ForegroundColor Green

# 配置云盘位置
Write-Host "`n[1/4] 配置云盘位置..." -ForegroundColor Cyan

$defaultCloudPath = "C:\cloud_data"
$cloudPath = Read-Host "请输入云盘根目录路径（默认：$defaultCloudPath）"
if ([string]::IsNullOrWhiteSpace($cloudPath)) {
    $cloudPath = $defaultCloudPath
}

# 验证驱动器有效性
$drive = $cloudPath.Substring(0, 2)
if (-not (Test-Path -Path $drive -PathType Container)) {
    Write-Error "错误：路径中的驱动器 $drive 不存在，请重新运行脚本"
    exit 1
}

# 处理路径转义（适配JS字符串）
$cloudEscaped = $cloudPath -replace "\\", "\\" -replace "'", "\'"
Write-Host "云盘路径（处理后）：$cloudEscaped"

# 确认路径
$confirm = Read-Host "确认使用此路径吗？(y/n，默认y)"
if ($confirm -eq "n" -or $confirm -eq "N") {
    Write-Host "请重新运行脚本设置路径"
    pause
    exit 0
}

# 设置管理员密码
Write-Host "`n[2/4] 设置管理员密码..." -ForegroundColor Cyan

do {
    $password = Read-Host "请设置管理员密码" -AsSecureString
    $passwordPlain = [System.Net.NetworkCredential]::new("", $password).Password
    if ([string]::IsNullOrWhiteSpace($passwordPlain)) {
        Write-Error "密码不能为空，请重新输入"
        continue
    }

    $passwordConfirm = Read-Host "请确认管理员密码" -AsSecureString
    $passwordConfirmPlain = [System.Net.NetworkCredential]::new("", $passwordConfirm).Password

    if ($passwordPlain -ne $passwordConfirmPlain) {
        Write-Error "两次输入的密码不一致，请重新输入"
        $passwordPlain = $null
    }
} while ([string]::IsNullOrWhiteSpace($passwordPlain))

# 生成密码哈希
Write-Host "`n[3/4] 生成密码哈希..." -ForegroundColor Cyan

$hashScript = @"
const bcrypt = require('bcryptjs');
bcrypt.genSalt(10, (err, salt) => {
    if (err) { console.error(err); process.exit(1); }
    bcrypt.hash('$passwordPlain', salt, (err, hash) => {
        if (err) { console.error(err); process.exit(1); }
        console.log(hash);
    });
});
"@

try {
    $passwordHash = node -e $hashScript 2>$null
    if (-not $passwordHash) {
        Write-Error "密码哈希生成失败，请检查 bcryptjs 是否安装正确"
        exit 1
    }
    $hashEscaped = $passwordHash -replace "'", "\'"
    Write-Host "密码哈希生成成功" -ForegroundColor Green
}
catch {
    Write-Error "生成哈希时出错：$_"
    exit 1
}

# 配置服务器文件
Write-Host "`n[4/4] 配置服务器文件..." -ForegroundColor Cyan

$serverJsPath = ".\server.js"
if (-not (Test-Path -Path $serverJsPath -PathType Leaf)) {
    Write-Error "未找到server.js，请确保脚本与server.js在同一目录"
    exit 1
}

# 备份原文件（如果不存在则创建，存在则覆盖）
$backupPath = ".\server.js.bak"
Copy-Item -Path $serverJsPath -Destination $backupPath -Force
if (Test-Path -Path $backupPath) {
    Write-Host "✅ 已备份原始文件到 server.js.bak"
}
else {
    Write-Warning "⚠️  无法创建备份文件，可能是权限不足"
}

# 替换配置内容（核心修复部分）
try {
    $content = Get-Content -Path $serverJsPath -Raw -Encoding UTF8
    $originalContent = $content  # 保存原始内容用于对比

    # 修复1：使用灵活的正则匹配云盘路径配置（忽略空格、注释等）
    # 匹配模式：const CLOUD_DIR = '任意内容'; （允许前后空格、分号后注释）
    $cloudRegex = '(?i)const\s+CLOUD_DIR\s*=\s*''.*?''\s*;'
    $newCloudLine = "const CLOUD_DIR = '$cloudEscaped';"
    $content = $content -replace $cloudRegex, $newCloudLine

    # 修复2：使用灵活的正则匹配密码哈希配置
    $hashRegex = '(?i)const\s+passwordHash\s*=\s*''.*?''\s*;'
    $newHashLine = "const passwordHash = '$hashEscaped';"
    $content = $content -replace $hashRegex, $newHashLine

    # 验证替换是否成功
    if ($content -eq $originalContent) {
        throw "替换失败！可能是 server.js 中未找到匹配的配置项（CLOUD_DIR 或 passwordHash）"
    }

    # 保存修改
    Set-Content -Path $serverJsPath -Value $content -Encoding UTF8
    Write-Host "✅ server.js 配置更新成功" -ForegroundColor Green

    # 验证修改结果
    $updatedContent = Get-Content -Path $serverJsPath -Raw -Encoding UTF8
    if ($updatedContent -match $cloudEscaped -and $updatedContent -match [regex]::Escape($hashEscaped.Substring(0, 20))) {
        Write-Host "✅ 验证通过：云盘路径和密码哈希已正确写入" -ForegroundColor Green
    }
    else {
        Write-Warning "⚠️  配置已保存，但验证未通过，请手动检查 server.js"
    }
}
catch {
    Write-Error "❌ 更新 server.js 失败：$_"
    # 恢复备份
    if (Test-Path -Path $backupPath) {
        Copy-Item -Path $backupPath -Destination $serverJsPath -Force
        Write-Host "✅ 已恢复原始 server.js 文件"
    }
    exit 1
}

Write-Host "`n===== 下载CSS等静态文件 =====" -ForegroundColor Green

# 资源下载脚本
# 运行此脚本将自动下载所有需要的资源文件
# 创建目录
$directories = @("public\assets\css", "public\assets\js", "public\assets\fonts")
foreach ($dir in $directories) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
        Write-Host "创建目录: $dir" -ForegroundColor Yellow
    }
}

# 下载 Font Awesome CSS
Write-Host "`n[1/4]下载 Font Awesome CSS..." -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/css/font-awesome.min.css" -OutFile "public\assets\css\font-awesome.min.css"
    # 更新字体路径 - 修复所有可能的路径格式
    $cssContent = Get-Content "public\assets\css\font-awesome.min.css" -Raw
    # 替换相对路径 ../fonts/ 为绝对路径 /assets/fonts/
    $cssContent = $cssContent -replace "\.\./fonts/", "/assets/fonts/"
    # 替换 fonts/ 为 /assets/fonts/
    $cssContent = $cssContent -replace "url\('fonts/", "url('/assets/fonts/"
    $cssContent = $cssContent -replace 'url\("fonts/', 'url("/assets/fonts/'
    # 替换 ..//assets/fonts/ 为 /assets/fonts/
    $cssContent = $cssContent -replace "\.\.//assets/fonts/", "/assets/fonts/"
    $cssContent | Set-Content "public\assets\css\font-awesome.min.css" -NoNewline
    Write-Host "✓ Font Awesome CSS 下载完成" -ForegroundColor Green
} catch {
    Write-Host "✗ Font Awesome CSS 下载失败: $_" -ForegroundColor Red
}

# 下载 Font Awesome 字体文件
Write-Host "`n[2/4]下载 Font Awesome 字体文件" -ForegroundColor Cyan
$fonts = @(
    @{Url="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/fonts/fontawesome-webfont.woff2"; File="fontawesome-webfont.woff2"},
    @{Url="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/fonts/fontawesome-webfont.woff"; File="fontawesome-webfont.woff"},
    @{Url="https://cdn.jsdelivr.net/npm/font-awesome@4.7.0/fonts/fontawesome-webfont.ttf"; File="fontawesome-webfont.ttf"}
)

foreach ($font in $fonts) {
    Write-Host "下载字体: $($font.File)..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $font.Url -OutFile "public\assets\fonts\$($font.File)"
        Write-Host "✓ $($font.File) 下载完成" -ForegroundColor Green
    } catch {
        Write-Host "✗ $($font.File) 下载失败: $_" -ForegroundColor Red
    }
}

# 下载 JSZip
Write-Host "`n[3/4]下载 JSZip..." -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri "https://s4.zstatic.net/ajax/libs/jszip/3.10.1/jszip.min.js" -OutFile "public\assets\js\jszip.min.js"
    Write-Host "✓ JSZip 下载完成" -ForegroundColor Green
} catch {
    Write-Host "✗ JSZip 下载失败: $_" -ForegroundColor Red
}

# 下载 epub.js
Write-Host "`n[4/4]下载 epub.js..." -ForegroundColor Cyan
try {
    Invoke-WebRequest -Uri "https://cdn.jsdelivr.net/npm/epubjs@0.3.88/dist/epub.min.js" -OutFile "public\assets\js\epub.min.js"
    Write-Host "✓ epub.js 下载完成" -ForegroundColor Green
} catch {
    Write-Host "✗ epub.js 下载失败: $_" -ForegroundColor Red
}

Write-Host "`n资源下载完成！" -ForegroundColor Green
# Tailwind CSS 配置步骤
Write-Host "`n开始配置 Tailwind CSS..." -ForegroundColor Cyan

Write-Host "`n===== 安装 Tailwind CSS 开发依赖 =====" -ForegroundColor Green

try {
    npm install -D tailwindcss
    Write-Host "✓ Tailwind CSS 安装完成" -ForegroundColor Green
} catch {
    Write-Host "✗ Tailwind CSS 安装失败: $_" -ForegroundColor Red
}

# 创建 input.css（如果不存在）
$inputCssPath = "public\assets\css\input.css"
if (-not (Test-Path $inputCssPath)) {
    Write-Host "创建 Tailwind 输入文件 input.css..." -ForegroundColor Cyan
    @'
@tailwind base;
@tailwind components;
@tailwind utilities;
'@ | Set-Content $inputCssPath -NoNewline
    Write-Host "✓ input.css 创建完成" -ForegroundColor Green
} else {
    Write-Host "✓ input.css 已存在，跳过创建" -ForegroundColor Green
}

# 构建 Tailwind CSS
Write-Host "构建 Tailwind CSS 样式文件..." -ForegroundColor Cyan
try {
    # 尝试更新 Browserslist 数据库以避免 caniuse-lite 过期警告
    Write-Host "尝试更新 Browserslist 数据库..." -ForegroundColor Cyan
    try {
        npx update-browserslist-db@latest --update-db --quiet 2>$null
        Write-Host "✓ Browserslist 数据库已更新" -ForegroundColor Green
    } catch {
        Write-Host "⚠️ 无法更新 Browserslist 数据库，继续构建..." -ForegroundColor Yellow
    }

    npm run build:css
    Write-Host "✓ Tailwind CSS 构建完成（tailwind.min.css）" -ForegroundColor Green
} catch {
    Write-Host "✗ Tailwind CSS 构建失败: $_" -ForegroundColor Red
}

try {
    npm install
    Write-Host "✓ 安装完成（tailwind.min.css）" -ForegroundColor Green
} catch {
    Write-Host "✗ 依赖有问题: $_" -ForegroundColor Red
}
Write-Host "`n所有资源下载和配置已完成！" -ForegroundColor Green

Write-Host "`n🎉 所有配置已完成！" -ForegroundColor Green
pause
