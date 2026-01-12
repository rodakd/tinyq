#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <pthread.h>

#define DEFAULT_PORT 7878
#define MAX_QUEUE_NAME 256
#define MAX_COMMAND_LEN 1024

typedef enum { CMD_ENQUEUE, CMD_DEQUEUE, CMD_LIST, CMD_UNKNOWN } cmd_t;

static cmd_t parse_command(const char *cmd) {
    if (strncmp(cmd, "ENQUEUE", 7) == 0) return CMD_ENQUEUE;
    if (strncmp(cmd, "DEQUEUE", 7) == 0) return CMD_DEQUEUE;
    if (strncmp(cmd, "LIST", 4) == 0) return CMD_LIST;
    return CMD_UNKNOWN;
}

typedef struct message_node {
    char *data;
    size_t length;
    struct message_node *next;
} message_node_t;

typedef struct queue {
    char name[MAX_QUEUE_NAME];
    message_node_t *head;
    message_node_t *tail;
    size_t count;
    pthread_mutex_t lock;
    struct queue *next;
} queue_t;

static queue_t *queues_head = NULL;
static pthread_mutex_t queues_lock = PTHREAD_MUTEX_INITIALIZER;
static volatile int running = 1;
static int server_fd = -1;

static queue_t *get_queue(const char *name, int create) {
    pthread_mutex_lock(&queues_lock);
    
    queue_t *q = queues_head;
    while (q) {
        if (strcmp(q->name, name) == 0) {
            pthread_mutex_unlock(&queues_lock);
            return q;
        }
        q = q->next;
    }
    
    if (!create) {
        pthread_mutex_unlock(&queues_lock);
        return NULL;
    }
    
    q = malloc(sizeof(queue_t));
    if (!q) {
        pthread_mutex_unlock(&queues_lock);
        return NULL;
    }
    
    strncpy(q->name, name, MAX_QUEUE_NAME - 1);
    q->name[MAX_QUEUE_NAME - 1] = '\0';
    q->head = NULL;
    q->tail = NULL;
    q->count = 0;
    pthread_mutex_init(&q->lock, NULL);
    q->next = queues_head;
    queues_head = q;
    
    pthread_mutex_unlock(&queues_lock);
    return q;
}

static int queue_enqueue(const char *queue_name, const char *data, size_t length) {
    queue_t *q = get_queue(queue_name, 1);
    if (!q) return -1;
    
    message_node_t *node = malloc(sizeof(message_node_t));
    if (!node) return -1;
    
    node->data = malloc(length + 1);
    if (!node->data) {
        free(node);
        return -1;
    }
    
    memcpy(node->data, data, length);
    node->data[length] = '\0';
    node->length = length;
    node->next = NULL;
    
    pthread_mutex_lock(&q->lock);
    if (q->tail) {
        q->tail->next = node;
        q->tail = node;
    } else {
        q->head = q->tail = node;
    }
    q->count++;
    pthread_mutex_unlock(&q->lock);
    
    return 0;
}

static char *queue_dequeue(const char *queue_name, size_t *out_length) {
    queue_t *q = get_queue(queue_name, 0);
    if (!q) {
        *out_length = 0;
        return NULL;
    }
    
    pthread_mutex_lock(&q->lock);
    if (!q->head) {
        pthread_mutex_unlock(&q->lock);
        *out_length = 0;
        return NULL;
    }
    
    message_node_t *node = q->head;
    q->head = node->next;
    if (!q->head) q->tail = NULL;
    q->count--;
    pthread_mutex_unlock(&q->lock);
    
    char *data = node->data;
    *out_length = node->length;
    free(node);
    return data;
}

static char **queue_list(const char *queue_name, int limit, int *out_count, size_t **out_lengths) {
    queue_t *q = get_queue(queue_name, 0);
    *out_count = 0;
    *out_lengths = NULL;
    
    if (!q) return NULL;
    
    pthread_mutex_lock(&q->lock);
    
    int count = (limit > 0 && (size_t)limit < q->count) ? limit : (int)q->count;
    if (count == 0) {
        pthread_mutex_unlock(&q->lock);
        return NULL;
    }
    
    char **messages = malloc(sizeof(char*) * count);
    size_t *lengths = malloc(sizeof(size_t) * count);
    if (!messages || !lengths) {
        free(messages);
        free(lengths);
        pthread_mutex_unlock(&q->lock);
        return NULL;
    }
    
    message_node_t *node = q->head;
    for (int i = 0; i < count && node; i++) {
        messages[i] = malloc(node->length + 1);
        if (messages[i]) {
            memcpy(messages[i], node->data, node->length);
            messages[i][node->length] = '\0';
            lengths[i] = node->length;
        }
        node = node->next;
    }
    
    pthread_mutex_unlock(&q->lock);
    
    *out_count = count;
    *out_lengths = lengths;
    return messages;
}

static ssize_t read_exact(FILE *f, char *buf, size_t n) {
    size_t total = 0;
    while (total < n) {
        size_t r = fread(buf + total, 1, n - total, f);
        if (r == 0) return -1;
        total += r;
    }
    return total;
}

static void handle_enqueue(FILE *in, FILE *out, const char *args) {
    char queue_name[MAX_QUEUE_NAME];
    
    if (sscanf(args, "%255s", queue_name) != 1) {
        fprintf(out, "ERR Missing queue name\n");
        fflush(out);
        return;
    }
    
    char len_buf[32];
    if (!fgets(len_buf, sizeof(len_buf), in)) {
        fprintf(out, "ERR Failed to read message length\n");
        fflush(out);
        return;
    }
    
    size_t msg_len = strtoul(len_buf, NULL, 10);
    if (msg_len == 0 || msg_len > 100 * 1024 * 1024) {
        fprintf(out, "ERR Invalid message length\n");
        fflush(out);
        return;
    }
    
    char *message = malloc(msg_len + 1);
    if (!message) {
        fprintf(out, "ERR Out of memory\n");
        fflush(out);
        return;
    }
    
    if (read_exact(in, message, msg_len) != (ssize_t)msg_len) {
        free(message);
        fprintf(out, "ERR Failed to read message\n");
        fflush(out);
        return;
    }
    message[msg_len] = '\0';
    
    if (queue_enqueue(queue_name, message, msg_len) == 0) {
        fprintf(out, "OK\n");
    } else {
        fprintf(out, "ERR Enqueue failed\n");
    }
    fflush(out);
    
    free(message);
}

static void handle_dequeue(FILE *out, const char *args) {
    char queue_name[MAX_QUEUE_NAME];
    
    if (sscanf(args, "%255s", queue_name) != 1) {
        fprintf(out, "ERR Missing queue name\n");
        fflush(out);
        return;
    }
    
    size_t length;
    char *message = queue_dequeue(queue_name, &length);
    
    if (message) {
        fprintf(out, "OK %zu\n", length);
        fwrite(message, 1, length, out);
        fflush(out);
        free(message);
    } else {
        fprintf(out, "ERR Queue empty\n");
        fflush(out);
    }
}

static void handle_list(FILE *out, const char *args) {
    char queue_name[MAX_QUEUE_NAME];
    int limit = 0;
    
    if (sscanf(args, "%255s %d", queue_name, &limit) < 1) {
        fprintf(out, "ERR Missing queue name\n");
        fflush(out);
        return;
    }
    
    int count;
    size_t *lengths;
    char **messages = queue_list(queue_name, limit, &count, &lengths);
    
    fprintf(out, "OK %d\n", count);
    
    for (int i = 0; i < count; i++) {
        fprintf(out, "%zu\n", lengths[i]);
        fwrite(messages[i], 1, lengths[i], out);
        free(messages[i]);
    }
    fflush(out);
    
    free(messages);
    free(lengths);
}

static void *handle_client(void *arg) {
    int fd = *(int*)arg;
    free(arg);
    
    int flag = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &flag, sizeof(flag));
    
    FILE *in = fdopen(fd, "r");
    FILE *out = fdopen(dup(fd), "w");
    if (!in || !out) {
        if (in) fclose(in);
        if (out) fclose(out);
        close(fd);
        return NULL;
    }
    
    setvbuf(in, NULL, _IOFBF, 8192);
    setvbuf(out, NULL, _IOFBF, 8192);
    
    char cmd_buf[MAX_COMMAND_LEN];
    
    while (running && fgets(cmd_buf, sizeof(cmd_buf), in)) {
        size_t len = strlen(cmd_buf);
        if (len > 0 && cmd_buf[len-1] == '\n') cmd_buf[len-1] = '\0';
        
        char cmd[16];
        char args[MAX_COMMAND_LEN];
        args[0] = '\0';
        
        if (sscanf(cmd_buf, "%15s %[^\n]", cmd, args) < 1) {
            fprintf(out, "ERR Invalid command\n");
            fflush(out);
            continue;
        }
        
        switch (parse_command(cmd)) {
            case CMD_ENQUEUE: handle_enqueue(in, out, args); break;
            case CMD_DEQUEUE: handle_dequeue(out, args); break;
            case CMD_LIST:    handle_list(out, args);    break;
            default:
                fprintf(out, "ERR Unknown command\n");
                fflush(out);
        }
    }
    
    fclose(in);
    fclose(out);
    return NULL;
}

static void sigint_handler(int sig) {
    (void)sig;
    running = 0;
    if (server_fd >= 0) {
        shutdown(server_fd, SHUT_RDWR);
        close(server_fd);
    }
}

int main(int argc, char *argv[]) {
    int port = DEFAULT_PORT;
    
    if (argc > 1) {
        port = atoi(argv[1]);
        if (port <= 0 || port > 65535) {
            fprintf(stderr, "Invalid port: %s\n", argv[1]);
            return 1;
        }
    }
    
    signal(SIGINT, sigint_handler);
    signal(SIGPIPE, SIG_IGN);
    
    server_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (server_fd < 0) {
        perror("socket");
        return 1;
    }
    
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_addr.s_addr = INADDR_ANY,
        .sin_port = htons(port)
    };
    
    if (bind(server_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        perror("bind");
        close(server_fd);
        return 1;
    }
    
    if (listen(server_fd, 128) < 0) {
        perror("listen");
        close(server_fd);
        return 1;
    }
    
    printf("tinyq listening on port %d\n", port);
    
    while (running) {
        struct sockaddr_in client_addr;
        socklen_t client_len = sizeof(client_addr);
        
        int *client_fd = malloc(sizeof(int));
        *client_fd = accept(server_fd, (struct sockaddr*)&client_addr, &client_len);
        
        if (*client_fd < 0) {
            free(client_fd);
            if (errno == EINTR) continue;
            if (!running) break;
            perror("accept");
            break;
        }
        
        pthread_t thread;
        pthread_create(&thread, NULL, handle_client, client_fd);
        pthread_detach(thread);
    }
    
    if (server_fd >= 0) close(server_fd);
    return 0;
}
