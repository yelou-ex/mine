/**
 * heading-ids.js — 标题锚点工具（Markdown 文章目录跳转支持）
 *
 * 背景：marked v5+ 默认不再为标题生成 slug id，md 文内目录链接 [文字](#标题)
 * 没有可命中的锚点，点击不会跳转。此文件在 marked 渲染结果后追加
 * GitHub 风格 id：小写、保留中英文/数字/-_/.、空格转连字符、重名自动 -1/-2。
 *
 * ⚠ 同步约定：functions/_lib.mjs 内的 ESM 版（Workers 无 window）必须与本文件
 * 行为保持一致，修改 slug 规则时两处同步更新。
 * 白名单（DOMPurify / 本地回退渲染器 / 服务端 sanitizeHtml）需同步放行 id 属性，
 * 否则锚点会被 XSS 过滤剥离。
 */
(function (root) {
    'use strict';

    // id 合法字符集：Unicode 字母（含中文）/ 数字 / - _ .
    var ID_PATTERN = /^[\p{L}\p{N}\-_.]+$/u;

    /**
     * 从标题（渲染后的 HTML 片段或纯文本）生成 GitHub 风格 slug。
     * 先剥离标签并解码 HTML 实体，再小写、去标点（保留 - _ .）、空格转连字符。
     */
    function headingSlug(raw) {
        var s = String(raw == null ? '' : raw);
        s = s.replace(/<[^>]*>/g, '');
        s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'")
             .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
                 try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; }
             })
             .replace(/&#(\d+);/g, function (_, d) {
                 try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; }
             })
             .replace(/&amp;/g, '&'); // 最后解码 &amp;（防 &amp;lt; 误判）
        s = s.trim().toLowerCase();
        s = s.replace(/[^\p{L}\p{N}\- _]/gu, ''); // 其余标点/符号（含 . ? 等）一律去掉，与 GitHub 规则一致
        s = s.replace(/\s+/g, '-');
        s = s.replace(/-{2,}/g, '-');
        s = s.replace(/^-+|-+$/g, '');
        return s;
    }

    /**
     * 为 HTML 中的 <h1>~<h6> 追加 id（重名自动 -1 / -2，GitHub 规则）；
     * 空 slug 的标题不追加，原样保留。代码块内被转义的伪标题不受影响。
     */
    function addHeadingIds(html) {
        var used = {};
        return String(html == null ? '' : html).replace(
            /<(h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi,
            function (m, tag, attrs, inner) {
                var base = headingSlug(inner);
                if (!base) return m;
                var id;
                if (Object.prototype.hasOwnProperty.call(used, base)) {
                    used[base] += 1;
                    id = base + '-' + used[base];
                } else {
                    used[base] = 0;
                    id = base;
                }
                if (!ID_PATTERN.test(id)) return m; // 双保险：理论上不会发生
                return '<' + tag + ' id="' + id + '">' + inner + '</' + tag + '>';
            }
        );
    }

    root.headingSlug = headingSlug;
    root.addHeadingIds = addHeadingIds;
    if (typeof module === 'object' && module.exports) {
        module.exports = { headingSlug: headingSlug, addHeadingIds: addHeadingIds };
    }
}(typeof window !== 'undefined' ? window : this));
