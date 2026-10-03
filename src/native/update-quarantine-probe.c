#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

enum { inherited_fd = 3, maximum_attribute_names = 1024 * 1024 };
static const char quarantine_attribute[] = "com.apple.quarantine";

static int write_status(char status) {
  const char output[] = {status, '\n'};
  size_t offset = 0;
  while (offset < sizeof(output)) {
    ssize_t written = write(STDOUT_FILENO, output + offset, sizeof(output) - offset);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    offset += (size_t)written;
  }
  return 0;
}

int main(int argc, char **argv) {
  (void)argv;
  if (argc != 1) return 2;

  ssize_t length = flistxattr(inherited_fd, NULL, 0, 0);
  if (length < 0) return 10;
  if (length == 0) return write_status('0') == 0 ? 0 : 11;
  if (length > maximum_attribute_names) return 12;

  char *names = malloc((size_t)length);
  if (names == NULL) return 13;
  ssize_t actual = flistxattr(inherited_fd, names, (size_t)length, 0);
  if (actual < 0 || actual > length) {
    free(names);
    return 14;
  }

  int quarantined = 0;
  size_t offset = 0;
  while (offset < (size_t)actual) {
    size_t remaining = (size_t)actual - offset;
    size_t name_length = strnlen(names + offset, remaining);
    if (name_length == remaining) {
      free(names);
      return 15;
    }
    if (name_length == sizeof(quarantine_attribute) - 1 &&
        memcmp(names + offset, quarantine_attribute, name_length) == 0) {
      quarantined = 1;
    }
    offset += name_length + 1;
  }
  free(names);
  return write_status(quarantined ? '1' : '0') == 0 ? 0 : 16;
}
