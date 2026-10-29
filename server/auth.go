package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type claims struct {
	UID    int64  `json:"uid"`
	OpenID string `json:"openid"`
	jwt.RegisteredClaims
}

type ctxKey string

const ctxUIDKey ctxKey = "uid"

// code2session：用小程序 wx.login() 给的 code 换 openid。
// session_key 不返回前端、不入库（只在解密手机号等场景需要）。
func (a *app) code2session(ctx context.Context, code string) (string, error) {
	endpoint := "https://api.weixin.qq.com/sns/jscode2session?grant_type=authorization_code" +
		"&appid=" + url.QueryEscape(a.cfg.wechatAppID) +
		"&secret=" + url.QueryEscape(a.cfg.wechatSecret) +
		"&js_code=" + url.QueryEscape(code)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}

	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("请求微信服务器: %w", err)
	}
	defer resp.Body.Close()

	var body struct {
		OpenID  string `json:"openid"`
		ErrCode int    `json:"errcode"`
		ErrMsg  string `json:"errmsg"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", fmt.Errorf("解析微信响应: %w", err)
	}
	if body.ErrCode != 0 {
		return "", fmt.Errorf("jscode2session 失败 %d: %s", body.ErrCode, body.ErrMsg)
	}
	if body.OpenID == "" {
		return "", fmt.Errorf("jscode2session 未返回 openid")
	}
	return body.OpenID, nil
}

func (a *app) signToken(uid int64, openid string) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(a.cfg.tokenTTL)
	c := claims{
		UID:    uid,
		OpenID: openid,
		RegisteredClaims: jwt.RegisteredClaims{
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	}
	tok, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(a.cfg.jwtSecret)
	return tok, exp, err
}

func (a *app) parseToken(tok string) (*claims, error) {
	c := &claims{}
	_, err := jwt.ParseWithClaims(tok, c, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("签名算法不允许: %v", t.Header["alg"])
		}
		return a.cfg.jwtSecret, nil
	})
	if err != nil {
		return nil, err
	}
	if c.UID <= 0 {
		return nil, fmt.Errorf("token 缺少 uid")
	}
	return c, nil
}

// requireAuth：从 JWT 取 uid 放进 context。
// 任何 handler 都不要接受前端传的 userId —— 这是最常见的越权漏洞。
func (a *app) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		raw := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if raw == "" {
			writeErr(w, http.StatusUnauthorized, "AUTH_MISSING", "缺少 Authorization: Bearer <token>")
			return
		}
		c, err := a.parseToken(raw)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "AUTH_EXPIRED", "token 无效或已过期，请重新登录")
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), ctxUIDKey, c.UID)))
	}
}

func uidFrom(r *http.Request) int64 {
	v, _ := r.Context().Value(ctxUIDKey).(int64)
	return v
}
