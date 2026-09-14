'use strict';

/**
 * 统一错误类型。所有"停机"类错误都必须带 reason（中文原因），用于界面与审计日志展示。
 */

class PromoBaseError extends Error {
  constructor(message, extra) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, extra || {});
  }
}

/** 数据源/操作适配器尚未接入真实页面（本轮无页面证据，禁止编造接口）。 */
class NotConnectedError extends PromoBaseError {
  constructor(what) {
    super(`${what}尚未接入真实页面，等待用户提供推广页面后补齐适配`);
    this.code = 'NOT_CONNECTED';
  }
}

/** 数据缺失/过期/解析失败/统计周期不一致 —— 停止本轮自动操作，缺失值绝不当 0。 */
class DataGuardError extends PromoBaseError {
  constructor(reason, detail) {
    super(reason);
    this.code = 'DATA_GUARD';
    this.reason = reason;
    this.detail = detail || null;
  }
}

/** 登录失效 / Cookie 不存在 / 身份不匹配。 */
class AuthError extends PromoBaseError {
  constructor(reason, detail) {
    super(reason);
    this.code = 'AUTH';
    this.reason = reason;
    this.detail = detail || null;
  }
}

/** 关闭操作发出后结果未知（超时等），必须回读确认，不能当成功也不能当失败。 */
class CloseOutcomeUnknownError extends PromoBaseError {
  constructor(reason, detail) {
    super(reason);
    this.code = 'CLOSE_UNKNOWN';
    this.reason = reason;
    this.detail = detail || null;
  }
}

/** 真实执行前置校验失败（身份/对象/触发数据复核不通过）。 */
class PreCheckError extends PromoBaseError {
  constructor(reason, detail) {
    super(reason);
    this.code = 'PRECHECK';
    this.reason = reason;
    this.detail = detail || null;
  }
}

module.exports = {
  PromoBaseError,
  NotConnectedError,
  DataGuardError,
  AuthError,
  CloseOutcomeUnknownError,
  PreCheckError,
};
