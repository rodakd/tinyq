FROM alpine:3.19 AS build
RUN apk add --no-cache gcc musl-dev
WORKDIR /src
COPY server.c .
RUN gcc -O2 -pthread -o tinyq-server server.c

FROM alpine:3.19
RUN apk add --no-cache libgcc
COPY --from=build /src/tinyq-server /usr/local/bin/
EXPOSE 7878
ENTRYPOINT ["tinyq-server"]
