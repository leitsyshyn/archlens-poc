workspace "ShopFlow" "Synthetic e-commerce platform. Demo model for the ArchLens proof of concept." {

    model {
        customer = person "Customer" "Buys products online."

        psp = softwareSystem "Payment Provider" "Processes card payments." "External"
        emailProvider = softwareSystem "Email Provider" "Delivers transactional email." "External"

        shop = softwareSystem "ShopFlow" "Online shop platform." {
            webApp = container "Web Application" "Storefront for browsers." "React" "Browser"
            mobileApp = container "Mobile Storefront" "Storefront for phones. Runs on customer devices, so it is not part of any server deployment." "Kotlin Multiplatform" "Mobile"
            apiGateway = container "API Gateway" "Single entry point for all clients." "Node.js / Express"
            catalogService = container "Catalog Service" "Product data and search." "Go"
            orderService = container "Order Service" "Order lifecycle." "Java / Spring Boot" {
                orderController = component "Order Controller" "REST endpoints for orders." "Spring MVC"
                orderFacade = component "Order Facade" "Order use cases." "Spring Bean"
                orderRepository = component "Order Repository" "Persists orders." "Spring Data JPA"
                pricingClient = component "Pricing Client" "Fetches current prices." "HTTP client"
                orderEventPublisher = component "Order Event Publisher" "Publishes order events." "Spring AMQP"
            }
            paymentService = container "Payment Service" "Payment authorisation and capture." "Java / Spring Boot" {
                paymentController = component "Payment Controller" "REST endpoints for payments." "Spring MVC"
                paymentProcessor = component "Payment Processor" "Payment use cases." "Spring Bean"
                fraudChecker = component "Fraud Checker" "Rule-based fraud screening." "Spring Bean"
                paymentRepository = component "Payment Repository" "Persists payments." "Spring Data JPA"
                pspAdapter = component "PSP Adapter" "Talks to the payment provider." "HTTP client"
                paymentEventConsumer = component "Payment Event Consumer" "Reacts to order events." "Spring AMQP"
            }
            notificationService = container "Notification Service" "Sends customer notifications." "Node.js" {
                eventListener = component "Event Listener" "Consumes domain events." "amqplib"
                templateRenderer = component "Template Renderer" "Renders message templates." "Handlebars"
                emailSender = component "Email Sender" "Hands messages to the email provider." "HTTP client"
            }
            catalogDb = container "Catalog Database" "Products." "MongoDB" "Database"
            orderDb = container "Order Database" "Orders." "PostgreSQL" "Database"
            paymentDb = container "Payment Database" "Payments." "PostgreSQL" "Database"
            cache = container "Session Cache" "Caches sessions and rate-limit counters." "Redis" "Cache"
            messageBus = container "Message Bus" "Asynchronous domain events." "RabbitMQ" "Queue"
        }

        # --- container level relationships
        customer -> webApp "Browses and orders using"
        customer -> mobileApp "Browses and orders using"
        webApp -> apiGateway "Calls" "HTTPS/JSON"
        mobileApp -> apiGateway "Calls" "HTTPS/JSON"
        apiGateway -> orderService "Routes order requests to" "gRPC"
        apiGateway -> cache "Caches sessions in" "RESP"
        orderService -> paymentService "Requests payment from" "gRPC"
        apiGateway -> catalogService "Routes catalog requests to" "gRPC"
        apiGateway -> paymentService "Routes payment requests to" "gRPC"
        catalogService -> catalogDb "Reads and writes" "MongoDB wire"
        orderService -> orderDb "Reads and writes" "JDBC"
        orderService -> catalogService "Fetches prices from" "gRPC"
        orderService -> messageBus "Publishes order events to" "AMQP"
        paymentService -> paymentDb "Reads and writes" "JDBC"
        paymentService -> psp "Authorises and captures payments with" "HTTPS/JSON"
        paymentService -> messageBus "Publishes payment events to" "AMQP"
        notificationService -> messageBus "Consumes events from" "AMQP"
        notificationService -> emailProvider "Sends email through" "HTTPS/JSON"

        # --- component level relationships
        apiGateway -> orderController "Routes order requests to" "gRPC"
        orderController -> orderFacade "Uses"
        orderFacade -> orderRepository "Uses"
        orderFacade -> pricingClient "Uses"
        orderFacade -> orderEventPublisher "Uses"
        orderRepository -> orderDb "Reads and writes" "JDBC"
        pricingClient -> catalogService "Fetches prices from" "gRPC"
        orderEventPublisher -> messageBus "Publishes order events to" "AMQP"

        paymentController -> paymentProcessor "Uses"
        orderFacade -> paymentController "Requests payment from" "gRPC"
        paymentProcessor -> fraudChecker "Screens payments with"
        paymentProcessor -> paymentRepository "Uses"
        paymentProcessor -> pspAdapter "Uses"
        paymentRepository -> paymentDb "Reads and writes" "JDBC"
        pspAdapter -> psp "Authorises and captures payments with" "HTTPS/JSON"
        messageBus -> paymentEventConsumer "Delivers order events to" "AMQP"
        paymentEventConsumer -> paymentProcessor "Uses"

        messageBus -> eventListener "Delivers events to" "AMQP"
        eventListener -> templateRenderer "Uses"
        templateRenderer -> emailSender "Uses"
        emailSender -> emailProvider "Sends email through" "HTTPS/JSON"

        # --- deployment (every node has an explicit identifier: Structurizr assigns random ones otherwise)
        staging = deploymentEnvironment "Staging" {
            stagingRegion = deploymentNode "Staging Region" "" "AWS eu-west-1" {
                stagingLoadBalancer = infrastructureNode "Load Balancer" "Routes HTTPS traffic." "AWS ALB"
                stagingCluster = deploymentNode "Staging Cluster" "" "Kubernetes" {
                    stagingWebPod = deploymentNode "Web Pod" "" "nginx" "" 1 {
                        stagingWebApp = containerInstance webApp
                    }
                    stagingGatewayPod = deploymentNode "Gateway Pod" "" "Docker" "" 1 {
                        stagingApiGateway = containerInstance apiGateway
                    }
                    stagingCatalogPod = deploymentNode "Catalog Pod" "" "Docker" "" 1 {
                        stagingCatalogService = containerInstance catalogService
                    }
                    stagingOrderPod = deploymentNode "Order Pod" "" "Docker" "" 1 {
                        stagingOrderService = containerInstance orderService
                    }
                    stagingPaymentPod = deploymentNode "Payment Pod" "" "Docker" "" 1 {
                        stagingPaymentService = containerInstance paymentService
                    }
                    stagingNotificationPod = deploymentNode "Notification Pod" "" "Docker" "" 1 {
                        stagingNotificationService = containerInstance notificationService
                    }
                }
                stagingDataStores = deploymentNode "Staging Data Stores" "" "Docker Compose" {
                    stagingMongo = deploymentNode "Mongo" "" "MongoDB 7" "" 1 {
                        stagingCatalogDb = containerInstance catalogDb
                    }
                    stagingPostgres = deploymentNode "Postgres" "" "PostgreSQL 16" "" 1 {
                        stagingOrderDb = containerInstance orderDb
                        stagingPaymentDb = containerInstance paymentDb
                    }
                    stagingBroker = deploymentNode "Broker" "" "RabbitMQ 3" "" 1 {
                        stagingMessageBus = containerInstance messageBus
                    }
                }
            }
        }

        production = deploymentEnvironment "Production" {
            productionRegion = deploymentNode "Production Region" "" "AWS eu-west-1" {
                productionLoadBalancer = infrastructureNode "Load Balancer" "Routes HTTPS traffic." "AWS ALB"
                productionWaf = infrastructureNode "Web Application Firewall" "Filters malicious traffic." "AWS WAF"
                productionCluster = deploymentNode "Production Cluster" "" "Kubernetes" {
                    productionWebPod = deploymentNode "Web Pod" "" "nginx" "" 3 {
                        productionWebApp = containerInstance webApp
                    }
                    productionGatewayPod = deploymentNode "Gateway Pod" "" "Docker" "" 4 {
                        productionApiGateway = containerInstance apiGateway
                    }
                    productionCatalogPod = deploymentNode "Catalog Pod" "" "Docker" "" 3 {
                        productionCatalogService = containerInstance catalogService
                    }
                    productionOrderPod = deploymentNode "Order Pod" "" "Docker" "" 3 {
                        productionOrderService = containerInstance orderService
                    }
                    productionPaymentPod = deploymentNode "Payment Pod" "" "Docker" "" 3 {
                        productionPaymentService = containerInstance paymentService
                    }
                    productionNotificationPod = deploymentNode "Notification Pod" "" "Docker" "" 2 {
                        productionNotificationService = containerInstance notificationService
                    }
                }
                productionCacheNode = deploymentNode "Cache Node" "" "AWS ElastiCache" "" 2 {
                    productionCache = containerInstance cache
                }
                productionDataStores = deploymentNode "Production Data Stores" "" "Managed services" {
                    productionAtlas = deploymentNode "Atlas" "" "MongoDB Atlas" "" 3 {
                        productionCatalogDb = containerInstance catalogDb
                    }
                    productionRds = deploymentNode "RDS" "" "Amazon RDS PostgreSQL" "" 2 {
                        productionOrderDb = containerInstance orderDb
                        productionPaymentDb = containerInstance paymentDb
                    }
                    productionAmazonMq = deploymentNode "Amazon MQ" "" "RabbitMQ" "" 2 {
                        productionMessageBus = containerInstance messageBus
                    }
                }
            }
        }
    }

    views {
        systemContext shop "systemContext" "System context of ShopFlow." {
            include *
            autoLayout
        }

        container shop "containers" "Containers of ShopFlow." {
            include *
            autoLayout
        }

        component orderService "orderComponents" "Components of the Order Service." {
            include *
            autoLayout
        }

        component paymentService "paymentComponents" "Components of the Payment Service." {
            include *
            autoLayout
        }

        dynamic shop "checkoutFlow" "Customer places an order on the phone and pays." {
            customer -> mobileApp "Submits order"
            mobileApp -> apiGateway "Sends order request"
            apiGateway -> orderService "Routes to Order Service"
            orderService -> catalogService "Fetches current prices"
            orderService -> paymentService "Requests payment"
            paymentService -> psp "Authorises and captures payment"
            orderService -> messageBus "Publishes OrderPlaced"
            messageBus -> notificationService "Delivers OrderPlaced"
            autoLayout
        }

        deployment shop "Staging" "stagingDeployment" "Staging deployment." {
            include *
            autoLayout
        }

        deployment shop "Production" "productionDeployment" "Production deployment." {
            include *
            autoLayout
        }
    }
}
