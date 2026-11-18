// Arasan in process (SPECS.md §5.1). The engine reads UCI from stdin and writes
// to stdout, so the process's fds 0 and 1 are replaced with pipes: we write
// commands into one and read the engine's lines from the other. Nothing else in
// the app reads stdin; anything else printed to stdout reaches JS as an unknown
// line, which the UCI client ignores.
//
// The engine's main loop runs on its own thread for the life of the process.
// It is never sent "quit": its globals can't be initialised twice.
#import "ArasanBridge.h"

#include <pthread.h>
#include <stdio.h>
#include <string>
#include <unistd.h>

int arasan_main(int argc, char **argv); // Arasan's main, renamed at build time

static void (^gOnLine)(NSString *) = nil;
static int gCommandFd = -1;
static std::string gProgramPath;

static void *runEngine(void *) {
  char *argv[] = {const_cast<char *>(gProgramPath.c_str()), nullptr};
  arasan_main(1, argv);
  return nullptr;
}

static void *readLines(void *arg) {
  FILE *in = fdopen((int)(intptr_t)arg, "r");
  char *line = nullptr;
  size_t cap = 0;
  ssize_t n;
  while ((n = getline(&line, &cap, in)) > 0) {
    while (n > 0 && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = '\0';
    NSString *text = [[NSString alloc] initWithBytes:line length:n encoding:NSUTF8StringEncoding];
    void (^cb)(NSString *) = gOnLine;
    if (text && cb) cb(text);
  }
  free(line);
  return nullptr;
}

static void spawn(void *(*fn)(void *), void *arg, size_t stack) {
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setstacksize(&attr, stack);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  pthread_t thread;
  pthread_create(&thread, &attr, fn, arg);
  pthread_attr_destroy(&attr);
}

@implementation ArasanBridge

+ (void)startWithProgramPath:(NSString *)programPath onLine:(void (^)(NSString *))onLine {
  @synchronized(self) {
    gOnLine = [onLine copy];
    if (gCommandFd >= 0) return;

    int commands[2], output[2];
    if (pipe(commands) != 0 || pipe(output) != 0) return;
    fflush(stdout);
    dup2(commands[0], STDIN_FILENO);
    dup2(output[1], STDOUT_FILENO);
    close(commands[0]);
    close(output[1]);
    gCommandFd = commands[1];
    gProgramPath = programPath.UTF8String;

    spawn(readLines, (void *)(intptr_t)output[0], 512 * 1024);
    // Like Arasan's own threads (globals::LINUX_STACK_SIZE is 4 MB), with headroom.
    spawn(runEngine, nullptr, 8 * 1024 * 1024);
  }
}

+ (void)send:(NSString *)command {
  if (gCommandFd < 0) return;
  std::string line = std::string(command.UTF8String) + "\n";
  const char *p = line.data();
  size_t left = line.size();
  while (left > 0) {
    ssize_t n = write(gCommandFd, p, left);
    if (n <= 0) return;
    p += n;
    left -= (size_t)n;
  }
}

@end
