import fs from 'fs';
import path from 'path';
import { createObjectCsvWriter } from 'csv-writer';

/**
 * 数据导出器 - 处理数据去重、格式转换和文件保存
 */
export class DataExporter {
  constructor(config) {
    this.config = config;
    this.collectedData = [];
  }

  /**
   * 添加数据到集合
   */
  addData(data) {
    if (Array.isArray(data)) {
      this.collectedData.push(...data);
    } else {
      this.collectedData.push(data);
    }

    console.log(`📦 当前收集: ${this.collectedData.length} 条数据`);
  }

  /**
   * 数据去重
   */
  deduplicate() {
    if (!this.config.output.deduplicate) {
      return this.collectedData;
    }

    console.log('🔄 正在去重...');

    const uniqueData = [];
    const seen = new Set();

    for (const item of this.collectedData) {
      // 生成唯一标识(根据username或id)
      const key = item.username || item.id || item.screen_name || JSON.stringify(item);

      if (!seen.has(key)) {
        seen.add(key);
        uniqueData.push(item);
      }
    }

    const removedCount = this.collectedData.length - uniqueData.length;

    if (removedCount > 0) {
      console.log(`✅ 去重完成,移除 ${removedCount} 条重复数据`);
    }

    return uniqueData;
  }

  /**
   * 生成文件名
   */
  generateFilename(extension) {
    if (this.config.output.filename) {
      return `${this.config.output.filename}.${extension}`;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const target = this.config.target.username || 'unknown';
    const type = this.config.target.type;

    return `${target}_${type}_${timestamp}.${extension}`;
  }

  /**
   * 导出为CSV
   */
  async exportToCsv(data) {
    console.log('📄 导出CSV文件...');

    const outputDir = this.config.output.directory;

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = this.generateFilename('csv');
    const filepath = path.join(outputDir, filename);

    // 如果数据为空,返回
    if (!data || data.length === 0) {
      console.warn('⚠️  没有数据可导出');
      return null;
    }

    // 获取所有可能的列名 (保持稳定顺序)
    const columns = this.extractColumns(data);

    // 标准化数据 (确保所有行有相同字段)
    const normalizedData = this.normalizeData(data, columns);

    // 创建CSV写入器
    const csvWriter = createObjectCsvWriter({
      path: filepath,
      header: columns.map(col => ({ id: col, title: col }))
    });

    // 写入数据
    await csvWriter.writeRecords(normalizedData);

    console.log(`✅ CSV文件已保存: ${filepath} (${normalizedData.length} 行, ${columns.length} 列)`);
    return filepath;
  }

  /**
   * 导出为JSON
   */
  async exportToJson(data) {
    console.log('📄 导出JSON文件...');

    const outputDir = this.config.output.directory;

    // 确保输出目录存在
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filename = this.generateFilename('json');
    const filepath = path.join(outputDir, filename);

    // 标准化数据 (确保字段一致)
    if (data && data.length > 0) {
      const columns = this.extractColumns(data);
      const normalizedData = this.normalizeData(data, columns);

      // 写入JSON文件
      fs.writeFileSync(filepath, JSON.stringify(normalizedData, null, 2), 'utf8');
      console.log(`✅ JSON文件已保存: ${filepath} (${normalizedData.length} 条记录)`);
    } else {
      // 空数据
      fs.writeFileSync(filepath, JSON.stringify([], null, 2), 'utf8');
      console.log(`✅ JSON文件已保存: ${filepath} (空)`);
    }

    return filepath;
  }

  /**
   * 提取所有列名 (保持稳定的顺序)
   */
  extractColumns(data) {
    // 使用第一条数据的字段作为基准,保持顺序
    const firstItem = data[0];
    const baseColumns = Object.keys(firstItem);

    // 收集其他数据中额外的字段
    const extraColumns = new Set();
    for (const item of data) {
      Object.keys(item).forEach(key => {
        if (!baseColumns.includes(key)) {
          extraColumns.add(key);
        }
      });
    }

    // 合并: 基础字段 + 额外字段 (保持稳定顺序)
    return [...baseColumns, ...Array.from(extraColumns).sort()];
  }

  /**
   * 标准化数据行 (确保所有行有相同的字段)
   */
  normalizeData(data, columns) {
    return data.map(item => {
      const normalized = {};
      columns.forEach(col => {
        normalized[col] = item[col] !== undefined ? item[col] : '';
      });
      return normalized;
    });
  }

  /**
   * 导出数据(根据配置选择格式)
   */
  async export() {
    console.log('💾 开始导出数据...');

    // 去重
    const uniqueData = this.deduplicate();

    if (uniqueData.length === 0) {
      console.warn('⚠️  没有数据可导出');
      return { csv: null, json: null };
    }

    console.log(`📊 总计: ${uniqueData.length} 条唯一数据`);

    const result = {
      csv: null,
      json: null
    };

    // 根据配置导出
    const format = this.config.output.format;

    if (format === 'csv' || format === 'both') {
      result.csv = await this.exportToCsv(uniqueData);
    }

    if (format === 'json' || format === 'both') {
      result.json = await this.exportToJson(uniqueData);
    }

    return result;
  }

  /**
   * 保存进度(断点续传)
   */
  async saveProgress(checkpointData) {
    const checkpointPath = path.join(this.config.output.directory, '.checkpoint.json');

    fs.writeFileSync(
      checkpointPath,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        collected: this.collectedData.length,
        target: this.config.target,
        data: checkpointData
      }, null, 2),
      'utf8'
    );

    console.log('💾 进度已保存');
  }

  /**
   * 加载进度(断点续传)
   */
  async loadProgress() {
    const checkpointPath = path.join(this.config.output.directory, '.checkpoint.json');

    if (!fs.existsSync(checkpointPath)) {
      return null;
    }

    try {
      const data = fs.readFileSync(checkpointPath, 'utf8');
      const checkpoint = JSON.parse(data);

      console.log(`📂 找到检查点: ${checkpoint.collected} 条数据 (${checkpoint.timestamp})`);

      return checkpoint;
    } catch (error) {
      console.warn('⚠️  无法加载检查点:', error.message);
      return null;
    }
  }

  /**
   * 清除进度
   */
  clearProgress() {
    const checkpointPath = path.join(this.config.output.directory, '.checkpoint.json');

    if (fs.existsSync(checkpointPath)) {
      fs.unlinkSync(checkpointPath);
      console.log('🗑️  检查点已清除');
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const uniqueData = this.deduplicate();

    return {
      total: this.collectedData.length,
      unique: uniqueData.length,
      duplicates: this.collectedData.length - uniqueData.length
    };
  }
}

export default DataExporter;
