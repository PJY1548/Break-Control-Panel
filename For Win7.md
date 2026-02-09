# --------- For Windows 7 -----------
## 一.[安装Vxkex](https://github.com/i486/VxKex) ; [安装.Net](https://dotnet.microsoft.com/zh-cn/download/dotnet-framework/net48) ; [安装WMF 5.1](https://www.microsoft.com/en-us/download/details.aspx?id=54616)
## 二.[下载Nodejs 22.21.1（LTS）](https://cdn.npmmirror.com/binaries/node/v22.21.1/node-v22.21.1-x64.msi)，并打开安装文件属性中Vxkex开关
#### 注：此时应该能正常安装
## 三.安装完成定位至安装目录（默认为C:\Program Files\nodejs）
### 1.将所有exe文件属性的Vxkex开关打开
### 2.完成后cmd测试node npm是否正常
#### 注：若文件缺失自行搜索填补，如:MSCVCPxxx.dll,Vcruntimexxx.dll ，并检查Vxkex是否正确开启
## 四.下载发布版本，存放至安装目录
### 1.右键setup.ps1点击编辑而不是运行 
### 2.在Powershell ISE中点击右上方的三角形运行
#### 注：忽略一些版本导致的语法错误
### 3.JSZips使用浏览器储存到项目\public\assets\js中（安全问题，无法解决）
### 4.卡在update-browserslist-db@1.2.3时，在上方编辑区将6-259行删除，保存并停止运行,先不关闭；
### 5.打开cmd定位到安装目录执行npm install update-browserslist-db@1.2.3
### 6.重新Powershell ISE中点击右上方的三角形运行
## 五.正常完成安装程序
