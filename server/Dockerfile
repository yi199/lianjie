# 多阶段构建：编译产物 ~15MB，运行镜像不需要 Go 工具链
FROM golang:1.26-alpine AS build
WORKDIR /src

# 先只拷依赖清单，让 go mod download 这一层能吃到缓存
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api .

FROM alpine:3.20
# ca-certificates：调用 api.weixin.qq.com 需要
# tzdata：TZ_NAME=Asia/Shanghai 需要，否则 time.LoadLocation 会失败
RUN apk add --no-cache ca-certificates tzdata && adduser -D -u 10001 app

WORKDIR /app
COPY --from=build /out/api /app/api

USER app
EXPOSE 8080
ENTRYPOINT ["/app/api"]
