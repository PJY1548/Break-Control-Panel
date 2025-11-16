# Break-Control-Panel
# 裂开の系统面板
仅浏览器实现远程关机重启-零成本云盘，预览视频，图片，文档（txt，pdf等），小说（epub）
一个开源的Web控制中心--安全，轻量，兼容

## --部署方式--
### 一.自动部署
#### 1.[安装node.js](https://nodejs.cn/en/download)并确保node npm正常使用
#### 2.下载发布版本，存放至安装目录，右键setup.ps1，使用powershell运行

### 二.手动部署（自定义）
#### 1.[安装node.js](https://nodejs.cn/en/download)并确保node npm正常使用
#### 2.存放至安装目录，在此处打开cmd 使用 npm install安装依赖
##### -使用node -e "console.log(require('bcryptjs').hashSync('你的密码', 10))"，将输出结果复制
##### -打开server.js修改
###### --Line20  将const CLOUD_DIR = 'C:\\cloud_data'的C:\\cloud_data 替换为想要的云盘目录（双斜杠）（自己创建）
###### --Line25  将const passwordHash = '$hashplaceholder$'的$hashplaceholder$替换为生成的密码hash
###### --Line501 在结尾处可以修改端口
#### 3.前端html位于public，可自行自定义

## --安装完成--
### 使用run.bat运行或直接使用node server.js

## --关于--
### 自启动：可以自行在run.bat中添加“cd 你的安装目录”，使用任务计划程序实现开机自启动
### 远程使用：
#### --使用cloudflare Tunnel实现零成本云盘（当然不算电费）
#### --使用FRP内网穿透工具
