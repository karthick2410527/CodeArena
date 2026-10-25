package dev.voidrun.worker;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class VoidRunWorkerApplication {

    public static void main(String[] args) {
        SpringApplication.run(VoidRunWorkerApplication.class, args);
    }
}
