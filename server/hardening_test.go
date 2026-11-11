package main

// 上线加固相关的单元测试：限流取 IP 的信任开关、客户端错误上报接口。
//
// 这一组都不碰数据库（handleClientError / clientIP 都不查库），
// 所以和 main_test.go 一样在没有 TEST_DATABASE_URL 时也能跑。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

/* ---------------- 限流取 IP ---------------- */

func TestClientIPIgnoresForgedHeaderByDefault(t *testing.T) {
	setTrustProxy(false)
	defer setTrustProxy(false)

	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "203.0.113.9:54321"
	r.Header.Set("X-Real-IP", "1.2.3.4") // 客户端伪造

	if got := clientIP(r); got != "203.0.113.9" {
		t.Fatalf("默认不能采信 X-Real-IP，期望 203.0.113.9，得到 %s", got)
	}
}

func TestClientIPUsesHeaderWhenTrustProxy(t *testing.T) {
	setTrustProxy(true)
	defer setTrustProxy(false)

	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "172.18.0.5:54321" // Nginx 容器的地址
	r.Header.Set("X-Real-IP", "203.0.113.9")

	if got := clientIP(r); got != "203.0.113.9" {
		t.Fatalf("开了 TRUST_PROXY 就该按 X-Real-IP 限流，得到 %s", got)
	}
}

func TestClientIPFallsBackToRemoteAddrWithoutHeader(t *testing.T) {
	setTrustProxy(true)
	defer setTrustProxy(false)

	r := httptest.NewRequest("POST", "/api/login", nil)
	r.RemoteAddr = "203.0.113.9:1234"

	if got := clientIP(r); got != "203.0.113.9" {
		t.Fatalf("没有头时要退回 RemoteAddr，得到 %s", got)
	}
}

/* ---------------- 客户端错误上报 ---------------- */

func newClientErrServer(t *testing.T) *httptest.Server {
	t.Helper()
	a := &app{} // 这个 handler 不碰 store
	lim := newLimiter(1000, 1000)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/client-error", lim.byIP(a.handleClientError))
	srv := httptest.NewServer(withTimeout(mux, 5*time.Second))
	t.Cleanup(srv.Close)
	return srv
}

func postClientErr(t *testing.T, srv *httptest.Server, body any) *http.Response {
	t.Helper()
	b, _ := json.Marshal(body)
	resp, err := http.Post(srv.URL+"/api/client-error", "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	resp.Body.Close()
	return resp
}

func TestClientErrorAcceptsKnownKinds(t *testing.T) {
	srv := newClientErrServer(t)
	for _, kind := range []string{"onError", "onUnhandledRejection", "onPageNotFound"} {
		resp := postClientErr(t, srv, clientError{
			Kind: kind, Page: "pages/today/index", Msg: "测试错误", Stack: "at a\nat b", Sid: "abc",
		})
		if resp.StatusCode != http.StatusNoContent {
			t.Fatalf("%s 应该被接受（204），得到 %d", kind, resp.StatusCode)
		}
	}
}

func TestClientErrorRejectsUnknownKind(t *testing.T) {
	srv := newClientErrServer(t)
	resp := postClientErr(t, srv, clientError{Kind: "随便什么", Msg: "x"})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("未知 kind 应该 400，得到 %d", resp.StatusCode)
	}
}

func TestClientErrorRejectsLongFields(t *testing.T) {
	srv := newClientErrServer(t)

	// 中文按字算：501 个汉字才超限（按字节算的话 167 个就炸，那是另一个 bug）
	resp := postClientErr(t, srv, clientError{Kind: "onError", Msg: strings.Repeat("错", maxClientErrMsg+1)})
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("超长 msg 应该 400，得到 %d", resp.StatusCode)
	}

	// 刚好到上限要放行：边界值别写成 >=
	resp = postClientErr(t, srv, clientError{Kind: "onError", Msg: strings.Repeat("错", maxClientErrMsg)})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("正好 %d 字应该放行，得到 %d", maxClientErrMsg, resp.StatusCode)
	}
}

func TestClientErrorRejectsHugeBody(t *testing.T) {
	srv := newClientErrServer(t)
	big := clientError{Kind: "onError", Stack: strings.Repeat("x", maxClientErrBody+1024)}
	resp := postClientErr(t, srv, big)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("超过 8KB 的请求体应该 400，得到 %d", resp.StatusCode)
	}
}

/* ---------------- 日志压行 ---------------- */

func TestOneLineFlattensStack(t *testing.T) {
	got := oneLine("Error: 炸了\n  at a\r\n  at b")
	if strings.ContainsAny(got, "\r\n") {
		t.Fatalf("日志里不能有换行，得到 %q", got)
	}
	if !strings.Contains(got, "at b") {
		t.Fatalf("内容不该被吃掉：%q", got)
	}
}
