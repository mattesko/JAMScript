#include <stdio.h>
#include <unistd.h>

int main(int argc, char* argv[])
{
	int n = 0;
	while (1) {
		sleep(1);
		printf("HELLO FROM C: %d\n", n);
		++n;
	}
	return 0;
}
