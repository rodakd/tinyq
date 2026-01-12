CC = gcc
CFLAGS = -Wall -Wextra -O2 -pthread
LDFLAGS = -pthread

.PHONY: all clean test

all: tinyq-server

tinyq-server: server.c
	$(CC) $(CFLAGS) -o $@ server.c $(LDFLAGS)

test: tinyq-server
	node --test test.js

clean:
	rm -f tinyq-server
