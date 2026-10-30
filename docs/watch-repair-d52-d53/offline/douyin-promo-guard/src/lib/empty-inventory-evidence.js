'use strict';

/**
 * 空表机读码（DIAN-4 阶段一，2026-10-22 独立审查边界）。
 *
 * 事实形态：页面声称有 1 行（分页 total=1），但本次 DOM 行数组为空。清单必需继续
 * unknown/blocked，**不得**当作无计划；但重新开一个会话做只读全量回读是安全的。
 *
 * 为什么必须是机读码而不是文案白名单：
 *  - 现网文案不编码 pageNo/activePage/hasNext，无法区分「第 1 页末页」与「第 2 页起」；
 *  - 数字 1 与字符串 "1" 会生成**完全相同**的文本，按文本匹配等于放行未知类型；
 *  - 展示用的组合原因（首次失败 + 重读失败）里会残留旧短语，按文本包含判定会把已不合格
 *    的店铺错误续上恢复链。
 * 因此本模块只认**结构化证据 + 严格相等**：证据由各站点亲自观测，机读码由掌握全部事实
 * （关闭证明与派发数）的一方铸造，消费方只做 `code === EMPTY_TABLE_CODE` 严格判定。
 */

const EMPTY_TABLE_CODE = 'cf-empty-total1:v1';
const SUBSELECT_TAB = '商品自选';

/**
 * 唯一判定：任一条件缺失/不明确/类型不符即**不成立**（fail-closed，宁可不重试）。
 * @param {object} ev 观测证据
 * @param {string} ev.tab 视图标签
 * @param {number} ev.pageNo 本次读取在清单内的第几页（从 1 计）
 * @param {number|string} ev.activePage 读取器实际回传的当前页码（必须显式为 1）
 * @param {Array} ev.rows 本次行数组
 * @param {{total?:*, hasNext?:*}} ev.pagination 原始分页字段（不做任何 coercion）
 * @param {boolean} ev.identityOk 本次会话身份核验已确认
 * @param {boolean} ev.refreshOk 视图切换/刷新后的重新读取已明确成功
 * @param {boolean} ev.closeProven 本次会话关闭已获明确证明（或动作会话已 settle 且无未收口读取门）
 * @param {number} ev.dispatched 本批次已派发（含结果未知）的开关动作数
 */
function evidenceCode(ev) {
  const e = ev || {};
  const pag = e.pagination || {};
  const rows = e.rows;
  return (
    e.tab === SUBSELECT_TAB
    && e.pageNo === 1
    && (e.activePage === 1 || e.activePage === '1')
    && Array.isArray(rows) && rows.length === 0
    && Number.isInteger(pag.total) && pag.total === 1
    && pag.hasNext === false
    && e.identityOk === true
    && e.refreshOk === true
    && e.closeProven === true
    && e.dispatched === 0
  ) ? EMPTY_TABLE_CODE : null;
}

/** 消费端唯一入口：严格相等，绝不包含匹配。 */
function isEmptyTableCode(v) {
  return typeof v === 'string' && v === EMPTY_TABLE_CODE;
}

module.exports = { EMPTY_TABLE_CODE, SUBSELECT_TAB, evidenceCode, isEmptyTableCode };
