'use strict';

/**
 * 生产环境启动入口：加载 dist 编译产物并启动 midway(egg) 应用
 * 本地开发请使用 `pnpm dev`（mwtsc --watch --run ./bootstrap.js）
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const { join } = require('path');
const { Bootstrap } = require('@midwayjs/bootstrap');

// baseDir 指向 dist：midway 容器只扫描编译产物，避免误加载 src 下的 ts 源文件
Bootstrap.configure({
  appDir: __dirname,
  baseDir: join(__dirname, 'dist'),
  configurationModule: require('./dist/configuration'),
});

Bootstrap.run();
